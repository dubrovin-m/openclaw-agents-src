import importlib.machinery
import importlib.util
import json
import tempfile
import unittest
from unittest import mock
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "bin" / "engineer-vps-maintenance-snapshot"
loader = importlib.machinery.SourceFileLoader("maintenance_snapshot", str(SOURCE))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)


def minimal_snapshot():
    command_ok = {"available": True, "exit_code": 0, "ok": True, "stdout": ""}
    return {
        "schema_version": 1,
        "collector_version": "test",
        "mode": "monthly",
        "generated_at_utc": "2026-10-05T00:00:00+00:00",
        "read_only_contract": True,
        "nexus": {
            "head": "a" * 40,
            "scheduled_maintenance_contract": "maintenance contract",
        },
        "versions": {"openclaw": {"stdout": "OpenClaw 2026.9.7"}},
        "openclaw_plugins": {
            "enabled_plugins": [
                {"id": "taskctl", "version": "0.4.31", "status": "loaded", "enabled": True}
            ]
        },
        "updates": {
            "apt_upgradable": command_ok,
            "apt_upgrade_simulation": command_ok,
            "ubuntu_security_status": {
                **command_ok,
                "stdout": json.dumps({"summary": {"num_standard_security_updates": 0}}),
            },
        },
        "official_sources": {
            "openclaw_latest_stable": {"tag": "v2026.9.8", "published_at": "2026-10-03"},
            "taskctl_compatibility": {"peerDependencies": {"openclaw": "<=2026.9.7"}},
        },
        "capacity": {
            "cpu_count": 2,
            "load_1m": 0.1,
            "load_5m": 0.2,
            "load_15m": 0.3,
            "memory": {"MemTotal": 1, "MemAvailable": 1, "SwapTotal": 1, "SwapFree": 1},
            "root_filesystem": {"bytes_available": 1},
            "home_filesystem": {"bytes_available": 1},
            "pressure": {},
        },
        "reliability": {
            "failed_user_units": command_ok,
            "failed_system_units": command_ok,
            "journal_errors": {},
            "kernel_oom": command_ok,
            "openclaw_automations": {"jobs": []},
        },
        "inventory": {
            "npm_global": {"packages": []},
            "listening_sockets": command_ok,
        },
        "cleanup": {
            "apt_autoremove_simulation": command_ok,
            "apt_cache": {},
            "journal_disk_usage": command_ok,
            "tmp_older_7d": {},
            "var_tmp_older_14d": {},
            "known_directory_sizes": [],
            "old_kernel_packages": command_ok,
            "docker_system_df": command_ok,
            "docker_containers": command_ok,
        },
        "configuration_drift": {
            "implementation_checkout": {},
            "public_implementation_main": "b" * 40,
        },
        "recovery_readiness": {
            "nexus_sync_unit": command_ok,
            "nexus_sync_timer": command_ok,
            "production_control_unit": command_ok,
            "backup_named_units": [],
            "root_available_bytes": 1,
        },
    }


class MaintenanceSnapshotTest(unittest.TestCase):
    def test_parse_mode_is_closed(self):
        self.assertEqual(module.parse_mode(["collector", "weekly"]), "weekly")
        self.assertEqual(module.parse_mode(["collector", "monthly"]), "monthly")
        self.assertEqual(
            module.parse_mode(["collector", "monthly", "--agent-output"]),
            "monthly",
        )
        with self.assertRaises(ValueError):
            module.parse_mode(["collector", "daily"])
        with self.assertRaises(ValueError):
            module.parse_mode(["collector", "monthly", "--verbose"])
        with self.assertRaises(ValueError):
            module.parse_mode(["collector", "monthly", "--agent-output", "extra"])

    def test_redaction(self):
        token = "sk-" + ("a" * 20)
        self.assertNotIn(token, module.redact("token=" + token))
        self.assertIn("<redacted", module.redact("password=hunter2"))

    def test_extract_markdown_section_stops_at_peer_heading(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "doc.md"
            path.write_text("## A\nalpha\n### Child\nbeta\n## B\ngamma\n", encoding="utf-8")
            section = module.extract_markdown_section(path, "## A")
            self.assertIn("alpha", section)
            self.assertIn("beta", section)
            self.assertNotIn("gamma", section)

    def test_dir_stats_is_read_only_aggregate(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "a").write_bytes(b"123")
            (root / "b").write_bytes(b"4567")
            stats = module.dir_stats(root)
            self.assertEqual(stats["file_count"], 2)
            self.assertEqual(stats["bytes"], 7)

    def test_automation_health_uses_large_json_budget(self):
        payload = '{"jobs":[{"id":"j1","name":"review","agentId":"engineer","enabled":true,"schedule":{},"state":{"lastRunStatus":"error","lastError":"boom"}}]}'
        with mock.patch.object(module, "run", return_value={"ok": True, "stdout": payload}) as run_mock:
            result = module.openclaw_automation_health()
        self.assertEqual(run_mock.call_args.kwargs["max_output"], 200000)
        self.assertEqual(result["jobs"][0]["last_status"], "error")
        self.assertEqual(result["jobs"][0]["last_error"], "boom")

    def test_agent_output_contains_all_maintenance_sections_and_is_bounded(self):
        result = module.compact_for_agent(minimal_snapshot())
        self.assertEqual(
            set(result["sections"]),
            {
                "updates",
                "cleanup",
                "capacity",
                "reliability",
                "configuration_drift",
                "recovery_readiness",
            },
        )
        encoded = json.dumps(result, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.assertLessEqual(len(encoded), module.AGENT_OUTPUT_MAX_BYTES)
        self.assertLessEqual(result["agent_output_bytes"], module.AGENT_OUTPUT_MAX_BYTES)

    def test_agent_output_fails_closed_when_limit_is_exceeded(self):
        snapshot = minimal_snapshot()
        with mock.patch.object(module, "AGENT_OUTPUT_MAX_BYTES", 100):
            with self.assertRaises(RuntimeError):
                module.compact_for_agent(snapshot)


if __name__ == "__main__":
    unittest.main()
