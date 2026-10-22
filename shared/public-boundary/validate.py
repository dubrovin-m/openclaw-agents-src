#!/usr/bin/env python3
"""Fail closed on structural private-source, credential, and unsafe CI indicators.

This is a public, heuristic guard, not a substitute for disclosure review.
No production identifiers, deny-list values, credentials, or private-source access
belong in this validator or its fixtures.
"""
from __future__ import annotations

import pathlib
import re
import subprocess
import sys
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
MAX_ARCHIVE_MEMBER_BYTES = 8 * 1024 * 1024

# Patterns deliberately describe *shapes*, not actual private identifiers.
# They do not match their own regular-expression source representation.
FORBIDDEN = [
    (
        re.compile(
            r"\b(?:private[_-](?:repo(?:sitory)?|remote|owner(?:[_-]id)?)|"
            r"production[_-](?:control[_-])?(?:issue|repo|owner|chat|telegram)"
            r"(?:[_-](?:id|url|number|remote))?)"
            r"\s*['\"]?\s*[:=]\s*['\"]?[^\s'\"#]+",
            re.IGNORECASE,
        ),
        "concrete private or production binding",
    ),
    (
        re.compile(r"\bproduction\s+control\s+issue\s+#\d+\b", re.IGNORECASE),
        "production control issue number",
    ),
    (
        # Match generic key headers without embedding actual private-key material.
        re.compile(
            r"-{5}BEGIN\s+(?:(?:OPENSSH|RSA|EC|DSA|ENCRYPTED|PGP)\s+)?"
            r"PRIVATE\s+KEY(?:\s+BLOCK)?-{5}",
            re.IGNORECASE,
        ),
        "private key header",
    ),
    (
        re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
        "provider credential-like material",
    ),
    (
        re.compile(r"\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}\b"),
        "GitHub credential-like material",
    ),
]


def tracked_files() -> list[pathlib.Path]:
    raw = subprocess.check_output(["git", "-C", str(ROOT), "ls-files", "-z"])
    return [ROOT / item.decode("utf-8") for item in raw.split(b"\0") if item]


def fail(message: str) -> None:
    print(f"PUBLIC_BOUNDARY_FAIL: {message}", file=sys.stderr)
    global FAILED
    FAILED = True


def scan_text(text: str, location: str) -> None:
    for pattern, label in FORBIDDEN:
        match = pattern.search(text)
        if match:
            line = text.count("\n", 0, match.start()) + 1
            # Never print the matching material, even on failure.
            fail(f"{label}: {location}:{line}")


def scan_file(path: pathlib.Path, relative: str) -> None:
    if path.suffix == ".tgz":
        # Release archives are published too. Do not silently exempt them.
        try:
            with tarfile.open(path, mode="r:gz") as archive:
                for member_number, member in enumerate(archive, 1):
                    if not member.isfile():
                        continue
                    if member.size > MAX_ARCHIVE_MEMBER_BYTES:
                        fail(f"oversized archive member: {relative}")
                        continue
                    handle = archive.extractfile(member)
                    if handle is None:
                        fail(f"unreadable archive member: {relative}")
                        continue
                    try:
                        text = handle.read(MAX_ARCHIVE_MEMBER_BYTES + 1).decode("utf-8")
                    except UnicodeDecodeError:
                        fail(f"non-text archive member: {relative}")
                        continue
                    scan_text(text, f"{relative}!member-{member_number}")
        except (OSError, tarfile.TarError, EOFError):
            fail(f"unreadable release archive: {relative}")
        return

    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        # A newly tracked binary or unreadable file must be reviewed explicitly;
        # silently skipping it creates an uncontrolled exception.
        fail(f"unscannable tracked file: {relative}")
        return
    scan_text(text, relative)


FAILED = False
try:
    files = tracked_files()
except (OSError, subprocess.CalledProcessError, UnicodeDecodeError):
    fail("unable to enumerate tracked files")
    files = []

for path in files:
    relative = path.relative_to(ROOT).as_posix()
    scan_file(path, relative)

workflow_paths = [
    path for path in files
    if path.relative_to(ROOT).as_posix().startswith(".github/workflows/")
    and path.suffix in {".yml", ".yaml"}
]

use_re = re.compile(r"^\s*-?\s*uses:\s*([^\s#]+)", re.MULTILINE)
write_permission_re = re.compile(r"^\s+[A-Za-z0-9_-]+:\s*write\s*(?:#.*)?$", re.MULTILINE)

for path in workflow_paths:
    relative = path.relative_to(ROOT).as_posix()
    try:
        text = path.read_text(encoding="utf-8")
    except (UnicodeDecodeError, OSError):
        # The scan above has already recorded a failure.
        continue
    if "pull_request_target" in text:
        fail(f"pull_request_target trigger is forbidden: {relative}")
    if re.search(r"\bsecrets\.", text):
        fail(f"secrets context is forbidden: {relative}")
    if re.search(r"runs-on:\s*(?:\[[^\]]*\bself-hosted\b|self-hosted\b)", text):
        fail(f"self-hosted runners are forbidden: {relative}")
    if write_permission_re.search(text):
        fail(f"write workflow permissions are forbidden: {relative}")
    if not re.search(r"^permissions:\s*$", text, re.MULTILINE):
        fail(f"explicit workflow permissions are required: {relative}")
    for use in use_re.finditer(text):
        spec = use.group(1)
        if spec.startswith("./"):
            continue
        if "@" not in spec or not re.fullmatch(r"[0-9a-fA-F]{40}", spec.rsplit("@", 1)[-1]):
            fail(f"action reference is not pinned to a full commit SHA: {relative}")

if FAILED:
    raise SystemExit(2)
print("PUBLIC_BOUNDARY_VALIDATION_PASS")
