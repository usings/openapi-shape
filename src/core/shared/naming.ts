const VALID_IDENT = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/;

const RESERVED = new Set(
  (
    "abstract any as asserts async await boolean break case catch class const constructor continue " +
    "debugger declare default delete do else enum export extends false finally for from function " +
    "get if implements import in infer instanceof interface is keyof let module namespace never " +
    "new null number object of package private protected public readonly require return satisfies " +
    "set static string super switch symbol this throw true try type typeof undefined unique unknown " +
    "var void while with yield"
  ).split(" "),
);

export function safeIdentifier(name: string): string {
  let out = name.replace(/[^a-zA-Z0-9_$]/g, "_");
  if (out === "") out = "_";
  if (/^[0-9]/.test(out)) out = "_" + out;
  if (RESERVED.has(out)) out = "_" + out;
  return out;
}

export function safeKey(name: string): string {
  return VALID_IDENT.test(name) ? name : JSON.stringify(name);
}
