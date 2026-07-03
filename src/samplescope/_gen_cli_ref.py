"""Generate the `sscope view` command reference from the Typer app itself.

The command surface documented in SKILL.md / README.md is NOT hand-written:
this module walks the click command tree behind `sscope view` and emits a
compact markdown reference (command line, one-line help, per-option help),
then splices it between BEGIN/END markers in each target file. Because the
text is derived from the same `typer.Option(help=...)` strings that `--help`
shows, the docs cannot drift from the CLI — `tests/test_cli_docs.py` fails
if a CLI change lands without rerunning this.

Usage:
    python -m samplescope._gen_cli_ref            # rewrite marked blocks in place
    python -m samplescope._gen_cli_ref --check    # exit 1 if any block is stale
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

import typer
# typer 0.26+ vendors click as `typer._click` (a slimmed fork that doesn't even
# export Group/Option/Argument); the command tree returned by
# `typer.main.get_command` is built from typer.core's Typer* subclasses, so
# isinstance checks against the standalone `click` package silently fail.
# Introspect with typer's own concrete classes.
from typer._click import Context
from typer.core import TyperArgument, TyperGroup, TyperOption

BEGIN = "<!-- BEGIN GENERATED: sscope-view-reference (python -m samplescope._gen_cli_ref) -->"
END = "<!-- END GENERATED: sscope-view-reference -->"

_REPO = Path(__file__).resolve().parents[2]
TARGETS = [
    Path(__file__).resolve().parent / "skill" / "SKILL.md",
    _REPO / "README.md",
]


def _metavar(p) -> str:
    if p.metavar:
        return p.metavar
    name = getattr(p.type, "name", "value").upper()
    return name


def _fmt_option(p: TyperOption) -> str | None:
    """One reference line for an option, or None for --help."""
    if "--help" in p.opts:
        return None
    decl = max(p.opts, key=len)
    head = decl if p.is_flag else f"{decl} {_metavar(p)}"
    if p.multiple:
        head += " (repeatable)"
    bits = []
    if p.help:
        bits.append(p.help)
    if p.default not in (None, False, (), []) and not p.is_flag:
        bits.append(f"[default: {p.default}]")
    tail = "  ".join(bits)
    return f"  {head:<34}{tail}".rstrip()


def _fmt_command(prefix: str, name: str, cmd) -> list[str]:
    args = []
    for p in cmd.params:
        if isinstance(p, TyperArgument):
            # The param *name* (`<path>`, `<idx>`), not the click metavar
            # (`TEXT`, `INTEGER`) — far more readable in a cheat sheet.
            mv = (p.metavar or p.name or "arg").lower()
            if p.nargs == -1 or p.multiple:
                mv += "..."
            args.append(f"<{mv}>" if p.required else f"[{mv}]")
    has_opts = any(isinstance(p, TyperOption) and "--help" not in p.opts for p in cmd.params)
    line = " ".join(filter(None, [prefix, name, *args, "[options]" if has_opts else ""]))
    out = [f"{line}"]
    help_line = (cmd.help or "").strip().splitlines()[0] if cmd.help else ""
    if help_line:
        out.append(f"  # {help_line}")
    for p in cmd.params:
        if isinstance(p, TyperOption):
            fmt = _fmt_option(p)
            if fmt:
                out.append(fmt)
    return out


def generate() -> str:
    """Render the full `sscope view` reference as one fenced markdown block."""
    from .cli import view_app

    group = typer.main.get_command(view_app)
    lines: list[str] = ["```"]
    ctx = Context(group)
    for name in group.list_commands(ctx):
        cmd = group.get_command(ctx, name)
        assert cmd is not None
        if isinstance(cmd, TyperGroup):
            sub_ctx = Context(cmd, parent=ctx)
            for sub_name in cmd.list_commands(sub_ctx):
                sub = cmd.get_command(sub_ctx, sub_name)
                assert sub is not None
                lines.extend(_fmt_command(f"sscope view {name}", sub_name, sub))
        else:
            lines.extend(_fmt_command("sscope view", name, cmd))
    lines.append("```")
    return "\n".join(lines)


def _splice(text: str, block: str, path: Path) -> str:
    pattern = re.compile(re.escape(BEGIN) + r".*?" + re.escape(END), re.DOTALL)
    if not pattern.search(text):
        sys.exit(f"{path}: missing generated-block markers ({BEGIN} … {END})")
    return pattern.sub(f"{BEGIN}\n{block}\n{END}", text)


def main() -> None:
    check = "--check" in sys.argv[1:]
    block = generate()
    stale = []
    for path in TARGETS:
        old = path.read_text()
        new = _splice(old, block, path)
        if new != old:
            if check:
                stale.append(path)
            else:
                path.write_text(new)
                print(f"updated {path}")
    if check and stale:
        sys.exit(
            "stale generated CLI reference in: "
            + ", ".join(str(p) for p in stale)
            + "\nrun: python -m samplescope._gen_cli_ref"
        )
    if check:
        print("CLI reference up to date")


if __name__ == "__main__":
    main()
