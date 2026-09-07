/**
 * What a scratch Python workspace is validated with.
 *
 * Until 2026-09-07 every phase of a generated Python workspace ran
 * `python -m compileall -q .`, which only byte-compiles. Cohort 14 lost its
 * third occurrence to a delivered number-guessing game whose
 * `choose_difficulty()` returned a four-tuple while its caller unpacked two:
 *
 *     def choose_difficulty() -> Tuple[str, int, int, int]:
 *         ...
 *         return DIFFICULTIES[choice]
 *
 *     key, (label, low, high, max_attempts) = choose_difficulty()
 *
 * That is a ValueError on every run, before the player can do anything. It
 * compiles perfectly, so three green validations and a "verified" delivery
 * later, the exported program crashed on launch. The mission's own next
 * action even read "Run the requested code until it exits with code 0" — the
 * catalog never ran or inspected it at all.
 *
 * Only ONE validation command may exist per phase (a second one is refused as
 * `sandbox_validation_command_ambiguous`), so the fix strengthens the single
 * command rather than adding another: the same compile check plus a static
 * unpacking-arity check, in stdlib Python, with no third-party dependency and
 * no write into the workspace being delivered.
 *
 * Deliberately NOT included: executing the program. That is the obvious next
 * step, and it would catch crashes before the first prompt, but it needs an
 * isolated copy of the workspace so a run cannot leave debris in what the
 * user receives. It is tracked separately rather than smuggled in here.
 */

/**
 * The checker, run as `python -c <source>` from the workspace root.
 *
 * It reports a call site only when the callee's arity is unambiguous, taking
 * the function's own return statements over its annotation when every return
 * is a tuple literal, and never flags a starred target. A disagreement it
 * does report is a guaranteed runtime ValueError, not a style opinion.
 */
export const SCRATCH_PYTHON_CONTRACT_CHECK_SOURCE_V1 = `import ast
import os
import sys

SKIP_DIRECTORIES = {
    ".git", "__pycache__", ".venv", "venv", "env", "node_modules",
    ".mypy_cache", ".pytest_cache", ".tox", "build", "dist", ".idea", ".vscode",
}
MAX_SOURCE_BYTES = 2000000


def iter_python_files(root):
    for base, directories, names in os.walk(root):
        directories[:] = sorted(
            name for name in directories
            if name not in SKIP_DIRECTORIES and not name.startswith(".")
        )
        for name in sorted(names):
            if name.endswith(".py"):
                yield os.path.join(base, name)


def fixed_tuple_arity(annotation):
    if not isinstance(annotation, ast.Subscript):
        return None
    base = annotation.value
    if isinstance(base, ast.Name):
        label = base.id
    elif isinstance(base, ast.Attribute):
        label = base.attr
    else:
        return None
    if label not in ("Tuple", "tuple"):
        return None
    inner = annotation.slice
    elements = inner.elts if isinstance(inner, ast.Tuple) else [inner]
    for element in elements:
        if isinstance(element, ast.Constant) and element.value is Ellipsis:
            return None
        if isinstance(element, ast.Starred):
            return None
    return len(elements)


def own_returns(function):
    found = []
    stack = list(function.body)
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            continue
        if isinstance(node, ast.Return):
            found.append(node)
        stack.extend(ast.iter_child_nodes(node))
    return found


def declared_arity(function):
    returns = own_returns(function)
    literals = [node.value for node in returns if isinstance(node.value, ast.Tuple)]
    if returns and len(literals) == len(returns):
        sizes = set()
        starred = False
        for literal in literals:
            sizes.add(len(literal.elts))
            for element in literal.elts:
                if isinstance(element, ast.Starred):
                    starred = True
        if not starred and len(sizes) == 1:
            return sizes.pop(), "its return statements"
    annotated = fixed_tuple_arity(function.returns)
    if annotated is not None:
        return annotated, "its return annotation"
    return None, None


def check_source(path, source, problems):
    try:
        compile(source, path, "exec")
    except SyntaxError as error:
        problems.append(
            "%s:%s: does not compile: %s" % (path, error.lineno or 0, error.msg)
        )
        return
    except ValueError as error:
        problems.append("%s: cannot be compiled: %s" % (path, error))
        return
    tree = ast.parse(source, path)
    arities = {}
    ambiguous = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        size, reason = declared_arity(node)
        if size is None:
            ambiguous.add(node.name)
            continue
        known = arities.get(node.name)
        if known is not None and known[0] != size:
            ambiguous.add(node.name)
        arities[node.name] = (size, reason)
    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        value = node.value
        if isinstance(value, ast.Await):
            value = value.value
        if not isinstance(value, ast.Call) or not isinstance(value.func, ast.Name):
            continue
        name = value.func.id
        if name in ambiguous or name not in arities:
            continue
        size, reason = arities[name]
        for target in node.targets:
            if not isinstance(target, (ast.Tuple, ast.List)):
                continue
            if any(isinstance(element, ast.Starred) for element in target.elts):
                continue
            if len(target.elts) == size:
                continue
            problems.append(
                "%s:%s: %s() returns %d value(s) according to %s, but this line "
                "unpacks %d. Python raises ValueError here on every run."
                % (path, node.lineno, name, size, reason, len(target.elts))
            )


def main():
    root = "."
    problems = []
    checked = 0
    for path in iter_python_files(root):
        try:
            with open(path, "r", encoding="utf-8") as handle:
                source = handle.read()
        except OSError as error:
            problems.append("%s: cannot be read: %s" % (path, error))
            continue
        except UnicodeDecodeError as error:
            problems.append("%s: is not valid UTF-8: %s" % (path, error))
            continue
        if len(source.encode("utf-8", "replace")) > MAX_SOURCE_BYTES:
            continue
        checked += 1
        check_source(path, source, problems)
    if problems:
        sys.stderr.write("Python validation failed:" + chr(10))
        for problem in problems:
            sys.stderr.write("  " + problem + chr(10))
        return 1
    sys.stdout.write(
        "Python validation passed: %d file(s) compile and unpack consistently." % checked
        + chr(10)
    )
    return 0


sys.exit(main())
`;

/**
 * Reassembles the checker from the argument vector.
 *
 * Three limits shape this. A trusted repository profile accepts at most 64
 * validation arguments of at most 500 characters and no newlines, so the
 * program travels neither as one `-c` string nor as one argument per line —
 * it runs to about 150 lines. And the profile parser TRIMS every argument and
 * rejects an empty one, so an argument may not begin with the indentation
 * Python depends on: a chunk starting with "    if ..." would arrive
 * de-indented and every Python validation would fail closed on an
 * IndentationError.
 *
 * So each source line is written preceded by a two-character backslash-n
 * escape, several lines to a chunk. Every argument therefore begins with a
 * backslash, never with a space; the bootstrap concatenates the arguments
 * with no separator and turns each escape back into a newline. The result
 * still reads as real Python rather than as a base64 blob. The checker
 * contains no backslash and no trailing whitespace of its own, which is what
 * keeps the escape unambiguous and the trimming harmless; tests pin both.
 */
export const SCRATCH_PYTHON_CHECK_BOOTSTRAP_V1 =
  'import sys;exec("".join(sys.argv[1:]).replace(chr(92)+chr(110),chr(10)))';

/** What `parseValidationCommand` and the provider spec both enforce. */
export const SANDBOX_ARGUMENT_LIMITS_V1 = {
  maxArguments: 64,
  maxArgumentChars: 500,
} as const;

/** Two characters, a backslash then an n: the in-argument line separator. */
export const SCRATCH_PYTHON_LINE_ESCAPE_V1 = "\\n";

/**
 * The argument vector for a scratch Python validation phase. `python` is the
 * pinned sandbox runtime; the checker arrives on the command line so nothing
 * is written into the workspace the user receives.
 */
export function scratchPythonContractCheckArgsV1(): string[] {
  const budget = SANDBOX_ARGUMENT_LIMITS_V1.maxArgumentChars;
  const chunks: string[] = [];
  let current = "";
  for (const line of SCRATCH_PYTHON_CONTRACT_CHECK_SOURCE_V1.split("\n")) {
    const encoded = `${SCRATCH_PYTHON_LINE_ESCAPE_V1}${line}`;
    if (current !== "" && current.length + encoded.length > budget) {
      chunks.push(current);
      current = encoded;
      continue;
    }
    current += encoded;
  }
  if (current !== "") chunks.push(current);
  return ["-c", SCRATCH_PYTHON_CHECK_BOOTSTRAP_V1, ...chunks];
}
