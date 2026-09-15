#!/usr/bin/env python3
from __future__ import annotations

import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
SELF = pathlib.Path(__file__).resolve().relative_to(ROOT).as_posix()

FORBIDDEN = [
    (re.compile(r"dubrovin-m/openclaw-agents(?!-src)(?:\.git)?"), "private operational repository identity"),
    (re.compile(r"dubrovin-m/nexus"), "private Nexus repository identity"),
    (re.compile(r"github-nexus"), "private Nexus authentication alias"),
    (re.compile(r"\b207328691\b"), "active production owner numeric identity"),
    (re.compile(r"CONTROL_ISSUE\s*=\s*16\b"), "active production control issue binding"),
    (re.compile(r"#16\s+Production Control", re.IGNORECASE), "active production control issue reference"),
    (re.compile(r"-----BEGIN (?:OPENSSH|RSA|EC|DSA)? ?PRIVATE KEY-----"), "private key material"),
    (re.compile(r"\bghp_[A-Za-z0-9]{20,}\b"), "GitHub token-like material"),
    (re.compile(r"\bgithub_pat_[A-Za-z0-9_]{20,}\b"), "GitHub fine-grained token-like material"),
    (re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"), "provider key-like material"),
]


def tracked_files() -> list[pathlib.Path]:
    output = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "-z"])
    return [ROOT / value.decode("utf-8") for value in output.split(b"\0") if value]


def text_of(path: pathlib.Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        return None


def fail(message: str) -> None:
    print(f"PUBLIC_BOUNDARY_FAIL: {message}", file=sys.stderr)
    global FAILED
    FAILED = True


FAILED = False
files = tracked_files()

for path in files:
    relative = path.relative_to(ROOT).as_posix()
    if relative == SELF:
        continue
    text = text_of(path)
    if text is None:
        continue
    for pattern, label in FORBIDDEN:
        match = pattern.search(text)
        if match:
            line = text.count("\n", 0, match.start()) + 1
            fail(f"{label}: {relative}:{line}")

workflow_paths = [
    path for path in files
    if path.relative_to(ROOT).as_posix().startswith(".github/workflows/")
    and path.suffix in {".yml", ".yaml"}
]

use_re = re.compile(r"^\s*-?\s*uses:\s*([^\s#]+)", re.MULTILINE)
write_permission_re = re.compile(r"^\s+[A-Za-z0-9_-]+:\s*write\s*(?:#.*)?$", re.MULTILINE)

for path in workflow_paths:
    relative = path.relative_to(ROOT).as_posix()
    text = text_of(path) or ""
    if "pull_request_target" in text:
        fail(f"pull_request_target is forbidden: {relative}")
    if re.search(r"\bsecrets\.", text):
        fail(f"GitHub Actions secrets are forbidden in initial public workflows: {relative}")
    if re.search(r"runs-on:\s*(?:\[[^\]]*\bself-hosted\b|self-hosted\b)", text):
        fail(f"self-hosted runner is forbidden: {relative}")
    if write_permission_re.search(text):
        fail(f"write-capable GITHUB_TOKEN permission is forbidden: {relative}")
    if not re.search(r"^permissions:\s*$", text, re.MULTILINE):
        fail(f"explicit workflow permissions are required: {relative}")
    for use in use_re.finditer(text):
        spec = use.group(1)
        if spec.startswith("./"):
            continue
        if "@" not in spec:
            fail(f"action reference is not pinned: {relative}: {spec}")
            continue
        revision = spec.rsplit("@", 1)[1]
        if not re.fullmatch(r"[0-9a-fA-F]{40}", revision):
            fail(f"action reference is not pinned to a full commit SHA: {relative}: {spec}")

if FAILED:
    raise SystemExit(2)

print("PUBLIC_BOUNDARY_VALIDATION_PASS")
