import importlib.machinery
import importlib.util
import tempfile
import unittest
from unittest import mock
from pathlib import Path

SOURCE = Path(__file__).resolve().parents[1] / "bin" / "engineer-vps-maintenance-snapshot"
loader = importlib.machinery.SourceFileLoader("maintenance_snapshot", str(SOURCE))
spec = importlib.util.spec_from_loader(loader.name, loader)
module = importlib.util.module_from_spec(spec)
loader.exec_module(module)


class MaintenanceSnapshotTest(unittest.TestCase):
    def test_parse_mode_is_closed(self):
        self.assertEqual(module.parse_mode(["collector", "weekly"]), "weekly")
        self.assertEqual(module.parse_mode(["collector", "monthly"]), "monthly")
        with self.assertRaises(ValueError):
            module.parse_mode(["collector", "daily"])
        with self.assertRaises(ValueError):
            module.parse_mode(["collector", "monthly", "extra"])

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


if __name__ == "__main__":
    unittest.main()
