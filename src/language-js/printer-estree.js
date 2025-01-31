"use strict";

/** @typedef {import("../document").Doc} Doc */

/** @type {import("assert")} */
const assert = require("assert");

// TODO(azz): anything that imports from main shouldn't be in a `language-*` dir.
const { printDanglingComments } = require("../main/comments");
const { hasNewline, printString, printNumber } = require("../common/util");
const {
  builders: { join, line, hardline, softline, literalline, group, indent },
} = require("../document");
const embed = require("./embed");
const clean = require("./clean");
const { insertPragma } = require("./pragma");
const handleComments = require("./comments");
const pathNeedsParens = require("./needs-parens");
const preprocess = require("./print-preprocess");
const {
  getCallArguments,
  hasFlowShorthandAnnotationComment,
  hasComment,
  CommentCheckFlags,
  isFunctionNotation,
  isGetterOrSetter,
  isTheOnlyJsxElementInMarkdown,
  isBlockComment,
  isLineComment,
  isNextLineEmpty,
  needsHardlineAfterDanglingComment,
  rawText,
  shouldPrintComma,
  hasIgnoreComment,
  isCallExpression,
  isMemberExpression,
} = require("./utils");
const { locStart, locEnd } = require("./loc");

const {
  printHtmlBinding,
  isVueEventBindingExpression,
} = require("./print/html-binding");
const { printAngular } = require("./print/angular");
const { printJsx, hasJsxIgnoreComment } = require("./print/jsx");
const { printFlow } = require("./print/flow");
const { printTypescript } = require("./print/typescript");
const {
  printOptionalToken,
  printBindExpressionCallee,
  printTypeAnnotation,
  adjustClause,
} = require("./print/misc");
const {
  printImportDeclaration,
  printExportDeclaration,
  printExportAllDeclaration,
  printModuleSpecifier,
} = require("./print/module");
const { printTernary } = require("./print/ternary");
const { printTemplateLiteral } = require("./print/template-literal");
const { printArray, printArrayItems } = require("./print/array");
const { printObject } = require("./print/object");
const {
  printClass,
  printClassMethod,
  printClassProperty,
} = require("./print/class");
const { printTypeParameters } = require("./print/type-parameters");
const { printPropertyKey, printProperty } = require("./print/property");
const {
  printFunctionDeclaration,
  printArrowFunctionExpression,
  printMethod,
  printReturnStatement,
  printThrowStatement,
} = require("./print/function");
const { printCallExpression } = require("./print/call-expression");
const { printInterface } = require("./print/interface");
const {
  printVariableDeclarator,
  printAssignmentExpression,
} = require("./print/assignment");
const { printBinaryishExpression } = require("./print/binaryish");
const { printSwitchCaseConsequent } = require("./print/statement");
const { printMemberExpression } = require("./print/member");
const { printBlock, printBlockBody } = require("./print/block");
const { printComment } = require("./print/comment");
const { printLiteral } = require("./print/literal");
const { printDecorators } = require("./print/decorators");

function genericPrint(path, options, print, args) {
  const printed = printPathNoParens(path, options, print, args);
  if (!printed) {
    return "";
  }

  const node = path.getValue();
  const { type } = node;
  // Their decorators are handled themselves, and they can't have parentheses
  if (
    type === "ClassMethod" ||
    type === "ClassPrivateMethod" ||
    type === "ClassProperty" ||
    type === "PropertyDefinition" ||
    type === "TSAbstractClassProperty" ||
    type === "ClassPrivateProperty" ||
    type === "MethodDefinition" ||
    type === "TSAbstractMethodDefinition" ||
    type === "TSDeclareMethod"
  ) {
    return printed;
  }

  const printedDecorators = printDecorators(path, options, print);
  // Nodes with decorators can't have parentheses
  if (printedDecorators) {
    return group([...printedDecorators, printed]);
  }

  const needsParens = pathNeedsParens(path, options);

  if (!needsParens) {
    return printed;
  }

  const parts = ["(", printed];

  if (hasFlowShorthandAnnotationComment(node)) {
    const [comment] = node.trailingComments;
    parts.push(" /*", comment.value.trimStart(), "*/");
    comment.printed = true;
  }

  parts.push(")");

  return parts;
}

function printPathNoParens(path, options, print, args) {
  const node = path.getValue();
  const semi = options.semi ? ";" : "";

  if (!node) {
    return "";
  }

  if (typeof node === "string") {
    return node;
  }

  for (const printer of [
    printLiteral,
    printHtmlBinding,
    printAngular,
    printJsx,
    printFlow,
    printTypescript,
  ]) {
    const printed = printer(path, options, print);
    if (typeof printed !== "undefined") {
      return printed;
    }
  }

  /** @type{Doc[]} */
  let parts = [];

  switch (node.type) {
    case "JsExpressionRoot":
      return path.call(print, "node");
    case "JsonRoot":
      return [path.call(print, "node"), hardline];
    case "File":
      // Print @babel/parser's InterpreterDirective here so that
      // leading comments on the `Program` node get printed after the hashbang.
      if (node.program && node.program.interpreter) {
        parts.push(path.call(print, "program", "interpreter"));
      }

      parts.push(path.call(print, "program"));

      return parts;

    case "Program":
      return printBlockBody(path, options, print);
    // Babel extension.
    case "EmptyStatement":
      return "";
    case "ExpressionStatement":
      // Detect Flow and TypeScript directives
      if (node.directive) {
        return [printDirective(node.expression, options), semi];
      }

      if (options.parser === "__vue_event_binding") {
        const parent = path.getParentNode();
        if (
          parent.type === "Program" &&
          parent.body.length === 1 &&
          parent.body[0] === node
        ) {
          return [
            path.call(print, "expression"),
            isVueEventBindingExpression(node.expression) ? ";" : "",
          ];
        }
      }

      // Do not append semicolon after the only JSX element in a program
      return [
        path.call(print, "expression"),
        isTheOnlyJsxElementInMarkdown(options, path) ? "" : semi,
      ];
    // Babel non-standard node. Used for Closure-style type casts. See postprocess.js.
    case "ParenthesizedExpression": {
      const shouldHug =
        !hasComment(node.expression) &&
        (node.expression.type === "ObjectExpression" ||
          node.expression.type === "ArrayExpression");
      if (shouldHug) {
        return ["(", path.call(print, "expression"), ")"];
      }
      return group([
        "(",
        indent([softline, path.call(print, "expression")]),
        softline,
        ")",
      ]);
    }
    case "AssignmentExpression":
      return printAssignmentExpression(path, options, print);
    case "VariableDeclarator":
      return printVariableDeclarator(path, options, print);
    case "BinaryExpression":
    case "LogicalExpression":
      return printBinaryishExpression(path, options, print);
    case "AssignmentPattern":
      return [path.call(print, "left"), " = ", path.call(print, "right")];
    case "OptionalMemberExpression":
    case "MemberExpression": {
      return printMemberExpression(path, options, print);
    }
    case "MetaProperty":
      return [path.call(print, "meta"), ".", path.call(print, "property")];
    case "BindExpression":
      if (node.object) {
        parts.push(path.call(print, "object"));
      }

      parts.push(
        group(
          indent([softline, printBindExpressionCallee(path, options, print)])
        )
      );

      return parts;
    case "Identifier": {
      return [
        node.name,
        printOptionalToken(path),
        printTypeAnnotation(path, options, print),
      ];
    }
    case "V8IntrinsicIdentifier":
      return ["%", node.name];
    case "SpreadElement":
    case "SpreadElementPattern":
    case "SpreadProperty":
    case "SpreadPropertyPattern":
    case "RestElement":
    case "ObjectTypeSpreadProperty":
      return [
        "...",
        path.call(print, "argument"),
        printTypeAnnotation(path, options, print),
      ];
    case "FunctionDeclaration":
    case "FunctionExpression": {
      let expandArg = false;
      if (args && args.expandLastArg) {
        const parent = path.getParentNode();
        if (isCallExpression(parent) && getCallArguments(parent).length > 1) {
          expandArg = true;
        }
      }
      return printFunctionDeclaration(path, print, options, expandArg);
    }
    case "ArrowFunctionExpression":
      return printArrowFunctionExpression(path, options, print, args);
    case "YieldExpression":
      parts.push("yield");

      if (node.delegate) {
        parts.push("*");
      }
      if (node.argument) {
        parts.push(" ", path.call(print, "argument"));
      }

      return parts;
    case "AwaitExpression": {
      parts.push("await");
      if (node.argument) {
        parts.push(" ", path.call(print, "argument"));
        const parent = path.getParentNode();
        if (
          (isCallExpression(parent) && parent.callee === node) ||
          (isMemberExpression(parent) && parent.object === node)
        ) {
          parts = [indent([softline, ...parts]), softline];
          const parentAwaitOrBlock = path.findAncestor(
            (node) =>
              node.type === "AwaitExpression" || node.type === "BlockStatement"
          );
          if (
            !parentAwaitOrBlock ||
            parentAwaitOrBlock.type !== "AwaitExpression"
          ) {
            return group(parts);
          }
        }
      }
      return parts;
    }
    case "ExportDefaultDeclaration":
    case "ExportNamedDeclaration":
      return printExportDeclaration(path, options, print);
    case "ExportAllDeclaration":
      return printExportAllDeclaration(path, options, print);
    case "ImportDeclaration":
      return printImportDeclaration(path, options, print);
    case "ImportSpecifier":
    case "ExportSpecifier":
    case "ImportNamespaceSpecifier":
    case "ExportNamespaceSpecifier":
    case "ImportDefaultSpecifier":
    case "ExportDefaultSpecifier":
      return printModuleSpecifier(path, options, print);
    case "ImportAttribute":
      return [path.call(print, "key"), ": ", path.call(print, "value")];
    case "Import":
      return "import";
    case "BlockStatement":
    case "StaticBlock":
    case "ClassBody":
      return printBlock(path, options, print);
    case "ThrowStatement":
      return printThrowStatement(path, options, print);
    case "ReturnStatement":
      return printReturnStatement(path, options, print);
    case "NewExpression":
    case "ImportExpression":
    case "OptionalCallExpression":
    case "CallExpression":
      return printCallExpression(path, options, print);
    case "ObjectTypeInternalSlot":
      return [
        node.static ? "static " : "",
        "[[",
        path.call(print, "id"),
        "]]",
        printOptionalToken(path),
        node.method ? "" : ": ",
        path.call(print, "value"),
      ];

    case "ObjectExpression":
    case "ObjectPattern":
    case "ObjectTypeAnnotation":
    case "RecordExpression":
      return printObject(path, options, print);
    // Babel 6
    case "ObjectProperty": // Non-standard AST node type.
    case "Property":
      if (node.method || node.kind === "get" || node.kind === "set") {
        return printMethod(path, options, print);
      }
      return printProperty(path, options, print);
    case "ObjectMethod":
      return printMethod(path, options, print);
    case "Decorator":
      return ["@", path.call(print, "expression")];
    case "ArrayExpression":
    case "ArrayPattern":
    case "TupleExpression":
      return printArray(path, options, print);
    case "SequenceExpression": {
      const parent = path.getParentNode(0);
      if (
        parent.type === "ExpressionStatement" ||
        parent.type === "ForStatement"
      ) {
        // For ExpressionStatements and for-loop heads, which are among
        // the few places a SequenceExpression appears unparenthesized, we want
        // to indent expressions after the first.
        const parts = [];
        path.each((expressionPath, index) => {
          if (index === 0) {
            parts.push(print(expressionPath));
          } else {
            parts.push(",", indent([line, print(expressionPath)]));
          }
        }, "expressions");
        return group(parts);
      }
      return group(join([",", line], path.map(print, "expressions")));
    }
    case "ThisExpression":
      return "this";
    case "Super":
      return "super";
    case "Directive":
      return [path.call(print, "value"), semi]; // Babel 6
    case "DirectiveLiteral":
      return printDirective(node, options);
    case "UnaryExpression":
      parts.push(node.operator);

      if (/[a-z]$/.test(node.operator)) {
        parts.push(" ");
      }

      if (hasComment(node.argument)) {
        parts.push(
          group([
            "(",
            indent([softline, path.call(print, "argument")]),
            softline,
            ")",
          ])
        );
      } else {
        parts.push(path.call(print, "argument"));
      }

      return parts;
    case "UpdateExpression":
      parts.push(path.call(print, "argument"), node.operator);

      if (node.prefix) {
        parts.reverse();
      }

      return parts;
    case "ConditionalExpression":
      return printTernary(path, options, print);
    case "VariableDeclaration": {
      const printed = path.map((childPath) => print(childPath), "declarations");

      // We generally want to terminate all variable declarations with a
      // semicolon, except when they in the () part of for loops.
      const parentNode = path.getParentNode();

      const isParentForLoop =
        parentNode.type === "ForStatement" ||
        parentNode.type === "ForInStatement" ||
        parentNode.type === "ForOfStatement";

      const hasValue = node.declarations.some((decl) => decl.init);

      let firstVariable;
      if (printed.length === 1 && !hasComment(node.declarations[0])) {
        firstVariable = printed[0];
      } else if (printed.length > 0) {
        // Indent first var to comply with eslint one-var rule
        firstVariable = indent(printed[0]);
      }

      parts = [
        node.declare ? "declare " : "",
        node.kind,
        firstVariable ? [" ", firstVariable] : "",
        indent(
          printed
            .slice(1)
            .map((p) => [
              ",",
              hasValue && !isParentForLoop ? hardline : line,
              p,
            ])
        ),
      ];

      if (!(isParentForLoop && parentNode.body !== node)) {
        parts.push(semi);
      }

      return group(parts);
    }
    case "WithStatement":
      return group([
        "with (",
        path.call(print, "object"),
        ")",
        adjustClause(node.body, path.call(print, "body")),
      ]);
    case "IfStatement": {
      const con = adjustClause(node.consequent, path.call(print, "consequent"));
      const opening = group([
        "if (",
        group([indent([softline, path.call(print, "test")]), softline]),
        ")",
        con,
      ]);

      parts.push(opening);

      if (node.alternate) {
        const commentOnOwnLine =
          hasComment(
            node.consequent,
            CommentCheckFlags.Trailing | CommentCheckFlags.Line
          ) || needsHardlineAfterDanglingComment(node);
        const elseOnSameLine =
          node.consequent.type === "BlockStatement" && !commentOnOwnLine;
        parts.push(elseOnSameLine ? " " : hardline);

        if (hasComment(node, CommentCheckFlags.Dangling)) {
          parts.push(
            printDanglingComments(path, options, true),
            commentOnOwnLine ? hardline : " "
          );
        }

        parts.push(
          "else",
          group(
            adjustClause(
              node.alternate,
              path.call(print, "alternate"),
              node.alternate.type === "IfStatement"
            )
          )
        );
      }

      return parts;
    }
    case "ForStatement": {
      const body = adjustClause(node.body, path.call(print, "body"));

      // We want to keep dangling comments above the loop to stay consistent.
      // Any comment positioned between the for statement and the parentheses
      // is going to be printed before the statement.
      const dangling = printDanglingComments(
        path,
        options,
        /* sameLine */ true
      );
      const printedComments = dangling ? [dangling, softline] : "";

      if (!node.init && !node.test && !node.update) {
        return [printedComments, group(["for (;;)", body])];
      }

      return [
        printedComments,
        group([
          "for (",
          group([
            indent([
              softline,
              path.call(print, "init"),
              ";",
              line,
              path.call(print, "test"),
              ";",
              line,
              path.call(print, "update"),
            ]),
            softline,
          ]),
          ")",
          body,
        ]),
      ];
    }
    case "WhileStatement":
      return group([
        "while (",
        group([indent([softline, path.call(print, "test")]), softline]),
        ")",
        adjustClause(node.body, path.call(print, "body")),
      ]);
    case "ForInStatement":
      return group([
        "for (",
        path.call(print, "left"),
        " in ",
        path.call(print, "right"),
        ")",
        adjustClause(node.body, path.call(print, "body")),
      ]);

    case "ForOfStatement":
      return group([
        "for",
        node.await ? " await" : "",
        " (",
        path.call(print, "left"),
        " of ",
        path.call(print, "right"),
        ")",
        adjustClause(node.body, path.call(print, "body")),
      ]);

    case "DoWhileStatement": {
      const clause = adjustClause(node.body, path.call(print, "body"));
      const doBody = group(["do", clause]);
      parts = [doBody];

      if (node.body.type === "BlockStatement") {
        parts.push(" ");
      } else {
        parts.push(hardline);
      }
      parts.push(
        "while (",
        group([indent([softline, path.call(print, "test")]), softline]),
        ")",
        semi
      );

      return parts;
    }
    case "DoExpression":
      return ["do ", path.call(print, "body")];
    case "BreakStatement":
      parts.push("break");

      if (node.label) {
        parts.push(" ", path.call(print, "label"));
      }

      parts.push(semi);

      return parts;
    case "ContinueStatement":
      parts.push("continue");

      if (node.label) {
        parts.push(" ", path.call(print, "label"));
      }

      parts.push(semi);

      return parts;
    case "LabeledStatement":
      if (node.body.type === "EmptyStatement") {
        return [path.call(print, "label"), ":;"];
      }

      return [path.call(print, "label"), ": ", path.call(print, "body")];
    case "TryStatement":
      return [
        "try ",
        path.call(print, "block"),
        node.handler ? [" ", path.call(print, "handler")] : "",
        node.finalizer ? [" finally ", path.call(print, "finalizer")] : "",
      ];
    case "CatchClause":
      if (node.param) {
        const parameterHasComments = hasComment(
          node.param,
          (comment) =>
            !isBlockComment(comment) ||
            (comment.leading &&
              hasNewline(options.originalText, locEnd(comment))) ||
            (comment.trailing &&
              hasNewline(options.originalText, locStart(comment), {
                backwards: true,
              }))
        );
        const param = path.call(print, "param");

        return [
          "catch ",
          parameterHasComments
            ? ["(", indent([softline, param]), softline, ") "]
            : ["(", param, ") "],
          path.call(print, "body"),
        ];
      }

      return ["catch ", path.call(print, "body")];
    // Note: ignoring n.lexical because it has no printing consequences.
    case "SwitchStatement":
      return [
        group([
          "switch (",
          indent([softline, path.call(print, "discriminant")]),
          softline,
          ")",
        ]),
        " {",
        node.cases.length > 0
          ? indent([
              hardline,
              join(
                hardline,
                path.map((casePath, index, cases) => {
                  const caseNode = casePath.getValue();
                  return [
                    casePath.call(print),
                    index !== cases.length - 1 &&
                    isNextLineEmpty(caseNode, options)
                      ? hardline
                      : "",
                  ];
                }, "cases")
              ),
            ])
          : "",
        hardline,
        "}",
      ];
    case "SwitchCase": {
      if (node.test) {
        parts.push("case ", path.call(print, "test"), ":");
      } else {
        parts.push("default:");
      }

      const consequent = node.consequent.filter(
        (node) => node.type !== "EmptyStatement"
      );

      if (consequent.length > 0) {
        const cons = printSwitchCaseConsequent(path, options, print);

        parts.push(
          consequent.length === 1 && consequent[0].type === "BlockStatement"
            ? [" ", cons]
            : indent([hardline, cons])
        );
      }

      return parts;
    }
    // JSX extensions below.
    case "DebuggerStatement":
      return ["debugger", semi];

    case "ClassDeclaration":
    case "ClassExpression":
      return printClass(path, options, print);
    case "ClassMethod":
    case "ClassPrivateMethod":
    case "MethodDefinition":
      return printClassMethod(path, options, print);
    case "ClassProperty":
    case "PropertyDefinition":
    case "ClassPrivateProperty":
      return printClassProperty(path, options, print);
    case "TemplateElement":
      return join(literalline, node.value.raw.split(/\r?\n/g));
    case "TemplateLiteral":
      return printTemplateLiteral(path, print, options);
    case "TaggedTemplateExpression":
      return [
        path.call(print, "tag"),
        path.call(print, "typeParameters"),
        path.call(print, "quasi"),
      ];
    // These types are unprintable because they serve as abstract
    // supertypes for other (printable) types.
    case "Node":
    case "Printable":
    case "SourceLocation":
    case "Position":
    case "Statement":
    case "Function":
    case "Pattern":
    case "Expression":
    case "Declaration":
    case "Specifier":
    case "NamedSpecifier":
    case "Comment":
    case "MemberTypeAnnotation": // Flow
    case "Type":
      /* istanbul ignore next */
      throw new Error("unprintable type: " + JSON.stringify(node.type));
    case "ExistsTypeAnnotation":
      return "*";
    case "EmptyTypeAnnotation":
      return "empty";
    case "MixedTypeAnnotation":
      return "mixed";
    case "ArrayTypeAnnotation":
      return [path.call(print, "elementType"), "[]"];
    case "BooleanLiteralTypeAnnotation":
      return String(node.value);

    case "EnumDeclaration":
      return ["enum ", path.call(print, "id"), " ", path.call(print, "body")];
    case "EnumBooleanBody":
    case "EnumNumberBody":
    case "EnumStringBody":
    case "EnumSymbolBody": {
      if (node.type === "EnumSymbolBody" || node.explicitType) {
        let type = null;
        switch (node.type) {
          case "EnumBooleanBody":
            type = "boolean";
            break;
          case "EnumNumberBody":
            type = "number";
            break;
          case "EnumStringBody":
            type = "string";
            break;
          case "EnumSymbolBody":
            type = "symbol";
            break;
        }
        parts.push("of ", type, " ");
      }
      if (node.members.length === 0 && !node.hasUnknownMembers) {
        parts.push(
          group(["{", printDanglingComments(path, options), softline, "}"])
        );
      } else {
        const members =
          node.members.length > 0
            ? [
                hardline,
                printArrayItems(path, options, "members", print),
                node.hasUnknownMembers || shouldPrintComma(options) ? "," : "",
              ]
            : [];

        parts.push(
          group([
            "{",
            indent([
              ...members,
              ...(node.hasUnknownMembers ? [hardline, "..."] : []),
            ]),
            printDanglingComments(path, options, /* sameIndent */ true),
            hardline,
            "}",
          ])
        );
      }
      return parts;
    }
    case "EnumBooleanMember":
    case "EnumNumberMember":
    case "EnumStringMember":
      return [
        path.call(print, "id"),
        " = ",
        typeof node.init === "object"
          ? path.call(print, "init")
          : String(node.init),
      ];
    case "EnumDefaultedMember":
      return path.call(print, "id");
    case "FunctionTypeParam": {
      const name = node.name
        ? path.call(print, "name")
        : path.getParentNode().this === node
        ? "this"
        : "";
      return [
        name,
        printOptionalToken(path),
        name ? ": " : "",
        path.call(print, "typeAnnotation"),
      ];
    }

    case "InterfaceDeclaration":
    case "InterfaceTypeAnnotation":
      return printInterface(path, options, print);
    case "ClassImplements":
    case "InterfaceExtends":
      return [path.call(print, "id"), path.call(print, "typeParameters")];
    case "NullableTypeAnnotation":
      return ["?", path.call(print, "typeAnnotation")];
    case "Variance": {
      const { kind } = node;
      assert.ok(kind === "plus" || kind === "minus");
      return kind === "plus" ? "+" : "-";
    }
    case "ObjectTypeCallProperty":
      if (node.static) {
        parts.push("static ");
      }

      parts.push(path.call(print, "value"));

      return parts;
    case "ObjectTypeIndexer": {
      return [
        node.variance ? path.call(print, "variance") : "",
        "[",
        path.call(print, "id"),
        node.id ? ": " : "",
        path.call(print, "key"),
        "]: ",
        path.call(print, "value"),
      ];
    }
    case "ObjectTypeProperty": {
      let modifier = "";

      if (node.proto) {
        modifier = "proto ";
      } else if (node.static) {
        modifier = "static ";
      }

      return [
        modifier,
        isGetterOrSetter(node) ? node.kind + " " : "",
        node.variance ? path.call(print, "variance") : "",
        printPropertyKey(path, options, print),
        printOptionalToken(path),
        isFunctionNotation(node) ? "" : ": ",
        path.call(print, "value"),
      ];
    }
    case "QualifiedTypeIdentifier":
      return [path.call(print, "qualification"), ".", path.call(print, "id")];
    case "StringLiteralTypeAnnotation":
      return printString(rawText(node), options);
    case "NumberLiteralTypeAnnotation":
      assert.strictEqual(typeof node.value, "number");
    // fall through
    case "BigIntLiteralTypeAnnotation":
      if (node.extra) {
        return printNumber(node.extra.raw);
      }
      return printNumber(node.raw);
    case "TypeCastExpression": {
      return [
        "(",
        path.call(print, "expression"),
        printTypeAnnotation(path, options, print),
        ")",
      ];
    }

    case "TypeParameterDeclaration":
    case "TypeParameterInstantiation": {
      const printed = printTypeParameters(path, options, print, "params");

      if (options.parser === "flow") {
        const start = locStart(node);
        const end = locEnd(node);
        const commentStartIndex = options.originalText.lastIndexOf("/*", start);
        const commentEndIndex = options.originalText.indexOf("*/", end);
        if (commentStartIndex !== -1 && commentEndIndex !== -1) {
          const comment = options.originalText
            .slice(commentStartIndex + 2, commentEndIndex)
            .trim();
          if (
            comment.startsWith("::") &&
            !comment.includes("/*") &&
            !comment.includes("*/")
          ) {
            return ["/*:: ", printed, " */"];
          }
        }
      }

      return printed;
    }

    case "InferredPredicate":
      return "%checks";
    // Unhandled types below. If encountered, nodes of these types should
    // be either left alone or desugared into AST types that are fully
    // supported by the pretty-printer.
    case "DeclaredPredicate":
      return ["%checks(", path.call(print, "value"), ")"];
    case "AnyTypeAnnotation":
    case "TSAnyKeyword":
      return "any";
    case "BooleanTypeAnnotation":
    case "TSBooleanKeyword":
      return "boolean";
    case "BigIntTypeAnnotation":
    case "TSBigIntKeyword":
      return "bigint";
    case "TSConstKeyword":
      return "const";
    case "NullLiteralTypeAnnotation":
    case "TSNullKeyword":
      return "null";
    case "NumberTypeAnnotation":
    case "TSNumberKeyword":
      return "number";
    case "SymbolTypeAnnotation":
    case "TSSymbolKeyword":
      return "symbol";
    case "StringTypeAnnotation":
    case "TSStringKeyword":
      return "string";
    case "VoidTypeAnnotation":
    case "TSVoidKeyword":
      return "void";
    case "ThisTypeAnnotation":
    case "TSThisType":
      return "this";

    case "PrivateIdentifier":
      return ["#", path.call(print, "name")];
    case "PrivateName":
      return ["#", path.call(print, "id")];

    case "InterpreterDirective":
      parts.push("#!", node.value, hardline);

      if (isNextLineEmpty(node, options)) {
        parts.push(hardline);
      }

      return parts;

    case "PipelineBareFunction":
      return path.call(print, "callee");
    case "PipelineTopicExpression":
      return path.call(print, "expression");
    case "PipelinePrimaryTopicReference": {
      parts.push("#");
      return parts;
    }

    case "ArgumentPlaceholder":
      return "?";

    default:
      /* istanbul ignore next */
      throw new Error("unknown type: " + JSON.stringify(node.type));
  }
}

function printDirective(node, options) {
  const raw = rawText(node);
  const rawContent = raw.slice(1, -1);

  // Check for the alternate quote, to determine if we're allowed to swap
  // the quotes on a DirectiveLiteral.
  if (rawContent.includes('"') || rawContent.includes("'")) {
    return raw;
  }

  const enclosingQuote = options.singleQuote ? "'" : '"';

  // Directives are exact code unit sequences, which means that you can't
  // change the escape sequences they use.
  // See https://github.com/prettier/prettier/issues/1555
  // and https://tc39.github.io/ecma262/#directive-prologue
  return enclosingQuote + rawContent + enclosingQuote;
}

function canAttachComment(node) {
  return (
    node.type &&
    !isBlockComment(node) &&
    !isLineComment(node) &&
    node.type !== "EmptyStatement" &&
    node.type !== "TemplateElement" &&
    node.type !== "Import" &&
    // `babel-ts` don't have similar node for `class Foo { bar() /* bat */; }`
    node.type !== "TSEmptyBodyFunctionExpression"
  );
}

module.exports = {
  preprocess,
  print: genericPrint,
  embed,
  insertPragma,
  massageAstNode: clean,
  hasPrettierIgnore(path) {
    return hasIgnoreComment(path) || hasJsxIgnoreComment(path);
  },
  willPrintOwnComments: handleComments.willPrintOwnComments,
  canAttachComment,
  printComment,
  isBlockComment,
  handleComments: {
    // TODO: Make this as default behavior
    avoidAstMutation: true,
    ownLine: handleComments.handleOwnLineComment,
    endOfLine: handleComments.handleEndOfLineComment,
    remaining: handleComments.handleRemainingComment,
  },
  getCommentChildNodes: handleComments.getCommentChildNodes,
};
