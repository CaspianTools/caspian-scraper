"""recordstore.py — SQLite working copy + committed JSONL mirror."""

from __future__ import annotations

import json

import recordstore as rs


def test_write_exports_sorted_lf_lines_and_reads_back(tmp_path):
    f = tmp_path / "db" / "things.jsonl"
    rs.write("db:things", {"b": {"id": "b", "name": "Bé"}, "a": {"id": "a", "z": 1, "k": [2]}}, file=f)
    raw = f.read_bytes()
    assert b"\r\n" not in raw
    assert raw.decode("utf-8").splitlines() == ['{"id": "a", "k": [2], "z": 1}', '{"id": "b", "name": "Bé"}']
    assert rs.load("db:things", f) == {"a": {"id": "a", "z": 1, "k": [2]}, "b": {"id": "b", "name": "Bé"}}


def test_a_changed_file_is_reimported_like_after_a_git_pull(tmp_path):
    f = tmp_path / "x.jsonl"
    rs.write("db:x", {"a": {"id": "a"}}, file=f)
    # git pull brings another computer's record (and the merged file).
    f.write_text('{"id": "a"}\n{"id": "c", "from": "pull"}\n', encoding="utf-8")
    assert sorted(rs.load("db:x", f)) == ["a", "c"]
    # A local write after the pull keeps both and exports them.
    rs.write("db:x", {"d": {"id": "d"}}, file=f)
    assert [json.loads(l)["id"] for l in f.read_text(encoding="utf-8").splitlines()] == ["a", "c", "d"]


def test_an_unchanged_file_is_not_reimported(tmp_path):
    f = tmp_path / "y.jsonl"
    rs.write("db:y", {"a": {"id": "a"}}, file=f)
    with rs.connect() as con:
        v1 = con.execute("SELECT version FROM versions WHERE store='db:y'").fetchone()[0]
    rs.load("db:y", f)
    with rs.connect() as con:
        assert con.execute("SELECT version FROM versions WHERE store='db:y'").fetchone()[0] == v1


def test_deletes_replace_and_local_only_stores(tmp_path):
    f = tmp_path / "z.jsonl"
    rs.write("db:z", {"a": {"id": "a"}, "b": {"id": "b"}}, file=f)
    rs.write("db:z", deletes=["a"], file=f)
    assert list(rs.load("db:z", f)) == ["b"] and '"a"' not in f.read_text(encoding="utf-8")
    rs.write("db:z", {"n": {"id": "n"}}, file=f, replace=True)
    assert list(rs.load("db:z", f)) == ["n"]
    rs.write("job:j", {"r1": {"id": "r1"}})           # a job store has no file
    assert rs.load("job:j") == {"r1": {"id": "r1"}} and rs.count("job:j") == 1


def test_broken_lines_in_a_merged_file_are_skipped(tmp_path):
    f = tmp_path / "m.jsonl"
    f.write_text('{"id": "a"}\n<<<<<<< HEAD\n{"id": "b"}\n', encoding="utf-8")
    assert sorted(rs.load("db:m", f)) == ["a", "b"]
