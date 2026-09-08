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
 * command rather than adding another: the same compile check plus two static
 * checks, in stdlib Python, with no third-party dependency and no write into
 * the workspace being delivered.
 *
 * The checks cover the ways generated code most often compiles and still
 * fails the person who asked for it: unpacking a call into the wrong number
 * of targets (ValueError), calling a function of this module with the wrong
 * arguments (TypeError), shipping a comment that says the code is unfinished,
 * and crashing when it is actually run.
 *
 * EVERY FINDING MUST BE A CERTAINTY. A false positive rejects a correct
 * delivery, which fails a mission and loses a campaign cohort worth hours; a
 * false negative costs one lane. A review of the first version found
 * twenty-five correct programs it rejected, so the rules below are now drawn
 * deliberately tight:
 *
 *   - Arity comes ONLY from a function whose every return is a tuple literal,
 *     or a row read out of a module-level table proved constant. The first
 *     version also trusted a `Tuple[...]` annotation, which is not enforced at
 *     runtime: `def words(line) -> Tuple[str]` meaning "a tuple of strings" is
 *     a common model error, and reading it as arity one rejected working code.
 *     Generators are excluded too, since `return 0, 0` in one is a
 *     StopIteration value, not a result.
 *   - The constant-table rule exists because the cohort-14 function returned
 *     `DIFFICULTIES[choice]`, so its arity was written in the table rather
 *     than in any return statement, and the annotation that did state it was
 *     the very thing that had to be dropped. A table earns the word constant
 *     only by being bound exactly once in the whole file — counting
 *     parameters, imports and every other binding form — with every value a
 *     tuple literal of one shared width, and no use that could change a row:
 *     no subscript assignment, no `del`, no method other than the read-only
 *     views, and never passed to a call, since the callee could mutate it.
 *   - A call or an unpack is judged only against a module-level function that
 *     is undecorated, defined once, not also defined nested, and whose name is
 *     never bound anywhere else in the file. "Bound anywhere" now means what
 *     Python means: assignment, import, class, parameter, `for` target,
 *     comprehension target, `with ... as`, `except ... as`, walrus, `global`.
 *     Missing those made an ordinary callback parameter look like a wrong
 *     call.
 *   - An unfinished marker must be the comment's own subject: the comment has
 *     to START with todo, fixme or placeholder. "Append a todo to the list"
 *     is a todo-list program describing itself, not an admission. Markers
 *     read from comment tokens only, so the word in a docstring, a string or
 *     an identifier is untouched.
 *   - Running the program fails it only on an exception that indicts the
 *     code. An exception meaning the environment refused something — no
 *     terminal behind a pipe, a missing file — is inconclusive, as is a
 *     timeout and an input stream running out.
 *
 * Removing the annotation rule costs nothing on the delivery that prompted it,
 * which had an entry point and is now caught by the run, reported with the
 * error Python itself prints. It did open a hole the reviewers found: a
 * program whose defective path the three input streams never reach exits
 * cleanly, and the static rules could not see through the table lookup. The
 * constant-table rule closes that, so the campaign's own headline defect is
 * now caught twice, statically and by running it, and neither route depends
 * on an annotation.
 *
 * The rules are held to eighty-four cases in the scratchpad corpus: correct
 * programs the checker must stay silent on, and defects it must report. Sixty
 * nine came from an adversarial review of the first version, fifteen were
 * written against the constant-table rule specifically, because a rule added
 * to catch a real defect is exactly the kind that starts rejecting correct
 * work. The corpus runs the program the sandbox will run, recovered from the
 * shipped argument vector, not a copy of it.
 */
export const SCRATCH_PYTHON_CONTRACT_CHECK_SOURCE_V1 = `import ast
import io
import os
import shutil
import subprocess
import sys
import tempfile
import tokenize

SKIP_DIRECTORIES = {
    ".git", "__pycache__", ".venv", "venv", "env", "node_modules",
    ".mypy_cache", ".pytest_cache", ".tox", "build", "dist", ".idea", ".vscode",
}
MAX_SOURCE_BYTES = 2000000
UNFINISHED_MARKERS = ("todo", "fixme", "placeholder")
# An exception saying the ENVIRONMENT refused something is not evidence that
# the delivered code is wrong. A piped stdout has no terminal size, a data
# file may legitimately be absent. Only exceptions that indict the code fail
# the validation.
INCONCLUSIVE_EXCEPTIONS = (
    "EOFError", "KeyboardInterrupt", "SystemExit", "OSError", "IOError",
    "FileNotFoundError", "PermissionError", "IsADirectoryError",
    "NotADirectoryError", "BrokenPipeError", "ConnectionError",
    "ConnectionResetError", "InterruptedError", "TimeoutError",
    "BlockingIOError", "ChildProcessError",
)
SMOKE_STREAMS = (
    "1" + chr(10) + ("50" + chr(10)) * 12 + "n" + chr(10),
    "2" + chr(10) + ("7" + chr(10)) * 12 + "no" + chr(10),
    chr(10) * 8,
)
SMOKE_TIMEOUT_SECONDS = 6
SMOKE_OUTPUT_LIMIT = 20000
DEF_TYPES = (ast.FunctionDef, ast.AsyncFunctionDef)


def iter_python_files(root):
    for base, directories, names in os.walk(root):
        directories[:] = sorted(
            name for name in directories
            if name not in SKIP_DIRECTORIES and not name.startswith(".")
        )
        for name in sorted(names):
            if name.endswith(".py"):
                yield os.path.join(base, name)


def unfinished_comment_markers(source):
    found = []
    try:
        tokens = list(tokenize.generate_tokens(io.StringIO(source).readline))
    except (tokenize.TokenError, IndentationError, SyntaxError):
        return found
    for token in tokens:
        if token.type != tokenize.COMMENT:
            continue
        text = token.string.lstrip("#").strip()
        lowered = text.lower()
        for marker in UNFINISHED_MARKERS:
            if not lowered.startswith(marker):
                continue
            rest = lowered[len(marker):]
            if rest and rest[0].isalnum():
                continue
            if rest.strip() and rest[0] not in ":;,.-( " + chr(9):
                continue
            found.append((token.start[0], marker, text[:120]))
            break
    return found


def bound_names(tree):
    bound = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            bound.add(node.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                bound.add((alias.asname or alias.name).split(".")[0])
        elif isinstance(node, ast.ClassDef):
            bound.add(node.name)
        elif isinstance(node, ast.Global) or isinstance(node, ast.Nonlocal):
            for name in node.names:
                bound.add(name)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            bound.add(node.name)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            spec = node.args
            for argument in spec.posonlyargs + spec.args + spec.kwonlyargs:
                bound.add(argument.arg)
            if spec.vararg is not None:
                bound.add(spec.vararg.arg)
            if spec.kwarg is not None:
                bound.add(spec.kwarg.arg)
    return bound


def module_level_functions(tree):
    functions = {}
    duplicated = set()
    for node in tree.body:
        if isinstance(node, DEF_TYPES):
            if node.name in functions:
                duplicated.add(node.name)
            functions[node.name] = node
    nested = set()
    for node in ast.walk(tree):
        if isinstance(node, DEF_TYPES) and node not in tree.body:
            nested.add(node.name)
    shadowed = bound_names(tree)
    return {
        name: node
        for name, node in functions.items()
        if name not in duplicated
        and name not in nested
        and name not in shadowed
        and not node.decorator_list
    }


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


def is_generator(function):
    stack = list(function.body)
    while stack:
        node = stack.pop()
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)):
            continue
        if isinstance(node, (ast.Yield, ast.YieldFrom)):
            return True
        stack.extend(ast.iter_child_nodes(node))
    return False


def constant_tuple_tables(tree):
    # The delivery that started all of this returned a row out of a module
    # level table rather than a tuple written in the return statement, so the
    # arity was invisible to a rule that only reads return statements, and the
    # annotation that did name it was the very thing that produced false
    # positives on correct programs. A table read like a constant is the one
    # remaining place the arity can be proved. Everything here is about
    # earning that word "constant": one binding, no mutation, and no use that
    # could hand the table to something that mutates it.
    candidates = {}
    for node in tree.body:
        if not isinstance(node, ast.Assign) or len(node.targets) != 1:
            continue
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            continue
        if not isinstance(node.value, ast.Dict) or not node.value.values:
            continue
        if any(key is None for key in node.value.keys):
            continue
        sizes = set()
        for value in node.value.values:
            if not isinstance(value, ast.Tuple):
                sizes.add(None)
                break
            if any(isinstance(e, ast.Starred) for e in value.elts):
                sizes.add(None)
                break
            sizes.add(len(value.elts))
        if len(sizes) != 1 or None in sizes:
            continue
        candidates[target.id] = sizes.pop()
    if not candidates:
        return {}
    # A second binding anywhere means the name is not a constant. That
    # includes a parameter of the same name, because inside such a function
    # the name refers to the parameter and the table says nothing about it.
    bindings = {}

    def note(name):
        bindings[name] = bindings.get(name, 0) + 1

    for node in ast.walk(tree):
        if isinstance(node, ast.Name) and isinstance(node.ctx, (ast.Store, ast.Del)):
            note(node.id)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                note((alias.asname or alias.name).split(".")[0])
        elif isinstance(node, ast.ClassDef):
            note(node.name)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            for name in node.names:
                note(name)
                note(name)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            note(node.name)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda)):
            if not isinstance(node, ast.Lambda):
                note(node.name)
            spec = node.args
            for argument in spec.posonlyargs + spec.args + spec.kwonlyargs:
                note(argument.arg)
            if spec.vararg is not None:
                note(spec.vararg.arg)
            if spec.kwarg is not None:
                note(spec.kwarg.arg)
    for name in list(candidates):
        if bindings.get(name, 0) != 1:
            candidates.pop(name, None)
    # Now the uses. Reading a row, asking for membership, and the read-only
    # dict views are safe; anything else could rebind or mutate a row, so the
    # table stops being evidence.
    safe_attributes = ("keys", "items", "values", "get", "copy")
    for node in ast.walk(tree):
        if isinstance(node, ast.Subscript) and isinstance(node.value, ast.Name):
            if node.value.id in candidates and not isinstance(node.ctx, ast.Load):
                candidates.pop(node.value.id, None)
        elif isinstance(node, ast.Attribute) and isinstance(node.value, ast.Name):
            if node.value.id in candidates and node.attr not in safe_attributes:
                candidates.pop(node.value.id, None)
        elif isinstance(node, ast.AugAssign) and isinstance(node.target, ast.Name):
            candidates.pop(node.target.id, None)
        elif isinstance(node, ast.Call):
            for argument in node.args + [k.value for k in node.keywords]:
                if isinstance(argument, ast.Name) and argument.id in candidates:
                    candidates.pop(argument.id, None)
                elif isinstance(argument, ast.Starred):
                    inner = argument.value
                    if isinstance(inner, ast.Name):
                        candidates.pop(inner.id, None)
    return candidates


def return_value_arity(node, tables):
    value = node.value
    if isinstance(value, ast.Tuple):
        if any(isinstance(e, ast.Starred) for e in value.elts):
            return None
        return len(value.elts)
    if isinstance(value, ast.Subscript) and isinstance(value.value, ast.Name):
        if isinstance(value.slice, ast.Slice):
            return None
        return tables.get(value.value.id)
    return None


def literal_return_arity(function, tables):
    if is_generator(function):
        return None
    returns = own_returns(function)
    if not returns:
        return None
    sizes = set()
    for node in returns:
        size = return_value_arity(node, tables)
        if size is None:
            return None
        sizes.add(size)
    if len(sizes) != 1:
        return None
    return sizes.pop()


def call_signature_problem(function, call):
    spec = function.args
    if spec.vararg is not None or spec.kwarg is not None:
        return None
    if any(isinstance(argument, ast.Starred) for argument in call.args):
        return None
    if any(keyword.arg is None for keyword in call.keywords):
        return None
    positional_names = [argument.arg for argument in spec.posonlyargs] + [
        argument.arg for argument in spec.args
    ]
    keyword_only_names = [argument.arg for argument in spec.kwonlyargs]
    positional_only = {argument.arg for argument in spec.posonlyargs}
    given_positional = len(call.args)
    if given_positional > len(positional_names):
        return "takes at most %d positional argument(s) but %d were given" % (
            len(positional_names),
            given_positional,
        )
    supplied = set(positional_names[:given_positional])
    for keyword in call.keywords:
        if keyword.arg in positional_only:
            return "does not accept %s as a keyword argument" % keyword.arg
        if keyword.arg not in positional_names and keyword.arg not in keyword_only_names:
            return "got an unexpected keyword argument %s" % keyword.arg
        if keyword.arg in supplied:
            return "got multiple values for argument %s" % keyword.arg
        supplied.add(keyword.arg)
    required_positional = positional_names[: len(positional_names) - len(spec.defaults)]
    missing = [name for name in required_positional if name not in supplied]
    for index, argument in enumerate(spec.kwonlyargs):
        if spec.kw_defaults[index] is None and argument.arg not in supplied:
            missing.append(argument.arg)
    if missing:
        return "is missing required argument(s): %s" % ", ".join(missing)
    return None


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
    for line, marker, text in unfinished_comment_markers(source):
        problems.append(
            "%s:%s: the delivered code marks itself unfinished (%s): %s"
            % (path, line, marker, text)
        )
    tree = ast.parse(source, path)
    functions = module_level_functions(tree)
    tables = constant_tuple_tables(tree)
    arities = {}
    for name, node in functions.items():
        size = literal_return_arity(node, tables)
        if size is not None:
            arities[name] = size
    for node in ast.walk(tree):
        if isinstance(node, ast.Assign):
            value = node.value
            if isinstance(value, ast.Await):
                value = value.value
            if isinstance(value, ast.Call) and isinstance(value.func, ast.Name):
                size = arities.get(value.func.id)
                if size is not None:
                    for target in node.targets:
                        if not isinstance(target, (ast.Tuple, ast.List)):
                            continue
                        if any(isinstance(e, ast.Starred) for e in target.elts):
                            continue
                        if len(target.elts) == size:
                            continue
                        problems.append(
                            "%s:%s: %s() returns %d value(s) according to its return "
                            "statements, but this line unpacks %d. Python raises "
                            "ValueError here on every run."
                            % (path, node.lineno, value.func.id, size, len(target.elts))
                        )
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            function = functions.get(node.func.id)
            if function is not None:
                problem = call_signature_problem(function, node)
                if problem is not None:
                    problems.append(
                        "%s:%s: %s() %s. Python raises TypeError here on every run."
                        % (path, node.lineno, node.func.id, problem)
                    )


def entry_point_path(root, paths):
    named = [path for path in paths if os.path.basename(path) == "main.py"]
    if named:
        return sorted(named, key=lambda item: (item.count(os.sep), item))[0]
    with_main = []
    for path in paths:
        try:
            with open(path, "r", encoding="utf-8-sig") as handle:
                if "__main__" in handle.read():
                    with_main.append(path)
        except (OSError, UnicodeDecodeError):
            continue
    if len(with_main) == 1:
        return with_main[0]
    if len(paths) == 1:
        return paths[0]
    return None


def traceback_kind(stderr):
    if "Traceback (most recent call last)" not in stderr:
        return None
    lines = [line for line in stderr.strip().split(chr(10)) if line.strip()]
    if not lines:
        return None
    return lines[-1].strip().split(":")[0].strip() or None


def run_smoke(root, entry):
    workspace = tempfile.mkdtemp(prefix="agentic-smoke-")
    try:
        copied = os.path.join(workspace, "workspace")
        shutil.copytree(root, copied)
        relative = os.path.relpath(entry, root)
        for stream in SMOKE_STREAMS:
            try:
                completed = subprocess.run(
                    [sys.executable, relative],
                    cwd=copied,
                    input=stream,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    timeout=SMOKE_TIMEOUT_SECONDS,
                    text=True,
                )
            except subprocess.TimeoutExpired:
                continue
            except OSError:
                return None
            stderr = (completed.stderr or "")[-SMOKE_OUTPUT_LIMIT:]
            kind = traceback_kind(stderr)
            if kind is None or kind in INCONCLUSIVE_EXCEPTIONS:
                continue
            detail = [line for line in stderr.strip().split(chr(10)) if line.strip()][-1]
            return "%s: running it raises %s. %s" % (relative, kind, detail[:200])
        return None
    finally:
        shutil.rmtree(workspace, ignore_errors=True)


def main():
    root = "."
    problems = []
    checked = 0
    collected = []
    for path in iter_python_files(root):
        collected.append(path)
        try:
            with open(path, "r", encoding="utf-8-sig") as handle:
                source = handle.read()
        except OSError as error:
            problems.append("%s: cannot be read: %s" % (path, error))
            continue
        except UnicodeDecodeError:
            continue
        if len(source.encode("utf-8", "replace")) > MAX_SOURCE_BYTES:
            continue
        checked += 1
        check_source(path, source, problems)
    if not problems and checked:
        entry = entry_point_path(root, collected)
        if entry is not None:
            failure = run_smoke(root, entry)
            if failure is not None:
                problems.append(failure)
    if problems:
        sys.stderr.write("Python validation failed:" + chr(10))
        for problem in problems:
            sys.stderr.write("  " + problem + chr(10))
        return 1
    sys.stdout.write(
        "Python validation passed: %d file(s) compile, unpack and call consistently." % checked
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
