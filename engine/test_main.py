import tempfile
import unittest
from pathlib import Path

import main as engine


class SensitiveFilesTests(unittest.TestCase):
    def test_dotfiles_are_sensitive_by_default(self):
        for name in (".claude.json", ".npmrc", ".netrc", ".git-credentials"):
            with self.subTest(name=name):
                self.assertTrue(engine._is_sensitive(name))

    def test_undotted_secret_names_are_sensitive(self):
        for name in ("credentials.json", "secrets.yaml", "serviceAccount.json",
                     "prod.tfvars", "terraform.tfstate", "keystore.jks"):
            with self.subTest(name=name):
                self.assertTrue(engine._is_sensitive(name))

    def test_regular_supported_files_remain_indexable(self):
        for name in ("notes.txt", "report.pdf", "config.json",
                     "secretariat.docx", "credentials_policy.md"):
            with self.subTest(name=name):
                self.assertFalse(engine._is_sensitive(name))

    def test_collect_skips_hidden_files_and_counts_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / ".claude.json").write_text('{"token":"secret"}', encoding="utf-8")
            (root / "notes.txt").write_text("safe content", encoding="utf-8")

            files, sensitive = engine._collect(root)

            self.assertEqual(sensitive, 1)
            self.assertEqual([f["name"] for f in files], ["notes.txt"])


class SecretContentTests(unittest.TestCase):
    SECRETS = (
        "-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n",
        "ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789",
        "aws_access_key_id = AKIAIOSFODNN7EXAMPLE",
        "token: ghp_1234567890abcdefghijklmnopqrstuvwxyzAB",
        "slack: xoxb-123456789012-abcdefghijkl",
        "key = AIzaSyA1234567890abcdefghijklmnopqrstuv",
        "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP",
    )

    NON_SECRETS = (
        "The password policy requires rotation every 90 days.",
        "See the AWS docs for how to configure your access key.",
        "def main():\n    return 42\n",
        "Mon mot de passe est dans le coffre-fort, pas ici.",
    )

    def test_known_token_shapes_are_detected(self):
        for text in self.SECRETS:
            with self.subTest(text=text[:40]):
                self.assertTrue(engine._has_secret(text))

    def test_ordinary_prose_and_code_are_not_flagged(self):
        for text in self.NON_SECRETS:
            with self.subTest(text=text[:40]):
                self.assertFalse(engine._has_secret(text))

    def test_secret_content_is_withheld_but_file_stays_findable(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            out = root / "index"
            leaky = root / "deploy-notes.txt"
            leaky.write_text(
                "Deploy steps\nexport KEY=sk-ant-api03-"
                "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789\n",
                encoding="utf-8",
            )
            clean = root / "meeting.txt"
            clean.write_text("Quarterly planning notes.", encoding="utf-8")

            files, _ = engine._collect(root)
            out.mkdir()
            _changed, secret_files = engine._build_fts(out, files)

            self.assertEqual(secret_files, 1)

            db = engine._fts_connect(out)
            try:
                rows = dict(db.execute("SELECT name, text FROM docs"))
                # name row survives, so the file is still findable by name
                self.assertIn("deploy-notes.txt", rows)
                self.assertEqual(rows["deploy-notes.txt"], "")
                self.assertIn("Quarterly", rows["meeting.txt"])
            finally:
                db.close()

    def test_secret_count_survives_an_incremental_update(self):
        """A refresh re-walks every file but only re-extracts changed ones, so
        the count must come from the stored flag, not from this pass."""
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            out = root / "index"
            (root / "creds.txt").write_text(
                "AKIAIOSFODNN7EXAMPLE", encoding="utf-8"
            )
            files, _ = engine._collect(root)
            out.mkdir()
            engine._build_fts(out, files)

            changed, secret_files = engine._build_fts(out, files)

            self.assertEqual(changed, 0)  # nothing was re-extracted
            self.assertEqual(secret_files, 1)


if __name__ == "__main__":
    unittest.main()
