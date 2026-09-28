// eval runs an expression: the extension compiles new Function("return ("
// + source + ")") in the page. A script of statements, or one that awaits
// at its top level, goes instead as an async function that returns the
// value of its last statement when that statement is an expression, as a
// console shows it. Bun parses with the same engine as Safari, so the
// choices below are made by parsing, which runs none of the code.

function parses(code: string): boolean {
  try {
    new Function(code);
    return true;
  } catch {
    return false;
  }
}

const asyncBody = (body: string) => `return async () => {${body}\n}`;

// A last statement that declares a function or class stays a declaration.
const DECLARATION = /^(?:\s|\/\/[^\n\r\u2028\u2029]*|\/\*[\s\S]*?\*\/)*(?:async\s+function|function|class)(?![\w$])/;

export function asExpression(source: string): string {
  if (!/\bawait\b/.test(source) && parses(`return (${source})`)) return source;
  // One that parses as neither goes as statements, so the page names the
  // error in them: as an expression, any script fails at its first keyword.
  if (!parses(asyncBody(source))) return `(async () => {${source}\n})()`;
  const { starts, joins, last } = statementStarts(source);
  // The last start after which the script before it parses is the last
  // statement's; a misread start fails that parse.
  for (let k = starts.length - 1; k >= -1; k--) {
    const start = k < 0 ? 0 : starts[k];
    const head = source.slice(0, start);
    if (!parses(asyncBody(head))) continue;
    // A brace the next token may carry on ends a statement only when nothing
    // can follow it the way it follows an expression: after a loop's or an
    // if's block, "(" starts a statement; after a function's, it calls it.
    if (joins.has(start) && parses(asyncBody(`${head}.x`))) continue;
    const tail = source.slice(start, last);
    if (DECLARATION.test(tail)) break;
    const body = `${head}\nreturn (${tail}\n)`;
    if (parses(asyncBody(body))) return `(async () => {${body}\n})()`;
    break;
  }
  return `(async () => {${source}\n})()`;
}

const LINE_END = /[\n\r\u2028\u2029]/;
const WORD = /[\w$]|[^\u0000-\u007f\s]/;
// Words after which a slash starts a regular expression, not a division.
const BEFORE_REGEX: Record<string, true> = { return: true, typeof: true, instanceof: true, in: true, of: true, new: true, delete: true, void: true, throw: true, case: true, do: true, else: true, yield: true, await: true };

// Whether a token that follows a line break, or a block's closing brace,
// carries on the statement before it, so no semicolon goes in between.
function continues(source: string, i: number, division: boolean): boolean {
  const c = source[i];
  if (c === "/") return division;
  if (c === "+" || c === "-") return source[i + 1] !== c;
  if (c === "!") return source[i + 1] === "=";
  return "([.,?:=*%&|^<>`".includes(c) || /^(?:in|instanceof)(?![\w$])/.test(source.slice(i, i + 11));
}

// Where each top-level statement of source may begin: after a semicolon,
// or after a line break or a block's closing brace that ends one; and where
// the last token ends. joins are the starts after a closing brace whose next
// token carries on an expression, and so a statement only after a block.
// Strings, templates, comments, and regular expressions are stepped over.
function statementStarts(source: string): { starts: number[]; joins: Set<number>; last: number } {
  const starts: number[] = [];
  const joins = new Set<number>();
  const templates: number[] = []; // the depth each open ${ in a template sits at
  let depth = 0;
  let last = 0;
  let prev = ""; // the last token: a word, "lit" for a literal, or a punctuator
  let open = false; // a statement has begun since the last start
  let soft = -1; // where a statement ends unless the next token carries it on
  let brace = -1; // soft, when a closing brace set it
  let i = 0;
  const n = source.length;
  // a template's text from i, up to its end or its next ${
  const template = () => {
    while (i < n && source[i] !== "`") {
      if (source[i] === "\\") i++;
      else if (source[i] === "$" && source[i + 1] === "{") {
        templates.push(depth++);
        i += 2;
        prev = "{";
        return;
      }
      i++;
    }
    i++;
    prev = "lit";
  };
  while (i < n) {
    const c = source[i];
    if (LINE_END.test(c)) {
      if (depth === 0 && open && soft < 0) soft = i + 1;
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "/") {
      while (i < n && !LINE_END.test(source[i])) i++;
      continue;
    }
    if (c === "/" && source[i + 1] === "*") {
      const close = source.indexOf("*/", i + 2);
      const end = close < 0 ? n : close + 2;
      const br = source.slice(i, end).search(LINE_END);
      if (br >= 0 && depth === 0 && open && soft < 0) soft = i + br + 1;
      i = end;
      continue;
    }
    const regex = c === "/" && (prev === "" || prev === "}" || BEFORE_REGEX[prev] || (prev.length === 1 && !WORD.test(prev) && prev !== ")" && prev !== "]"));
    if (soft >= 0 && !continues(source, i, c === "/" && !regex)) starts.push(soft);
    else if (soft >= 0 && soft === brace) {
      starts.push(soft);
      joins.add(soft);
    }
    soft = -1;
    if (c === ";") {
      if (depth === 0) {
        starts.push(i + 1);
        open = false;
      }
      prev = ";";
      i++;
      continue;
    }
    open = true;
    if (WORD.test(c)) {
      const from = i;
      while (i < n && WORD.test(source[i])) i++;
      prev = source.slice(from, i);
    } else if (c === '"' || c === "'") {
      for (i++; i < n && source[i] !== c && !LINE_END.test(source[i]); i++) if (source[i] === "\\") i++;
      i++;
      prev = "lit";
    } else if (c === "`") {
      i++;
      template();
    } else if (regex) {
      let inClass = false;
      for (i++; i < n && !LINE_END.test(source[i]); i++) {
        if (source[i] === "\\") i++;
        else if (source[i] === "[") inClass = true;
        else if (source[i] === "]") inClass = false;
        else if (source[i] === "/" && !inClass) break;
      }
      i++;
      while (i < n && WORD.test(source[i])) i++;
      prev = "lit";
    } else if (c === "}" && templates.at(-1) === depth - 1) {
      templates.pop();
      depth--;
      i++;
      template();
    } else {
      if ("([{".includes(c)) depth++;
      if (")]}".includes(c)) depth--;
      if (c === "}" && depth === 0) soft = brace = i + 1;
      prev = c;
      i++;
    }
    last = Math.min(i, n);
  }
  return { starts: starts.filter((s) => s < last), joins, last };
}
