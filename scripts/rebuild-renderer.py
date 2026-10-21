#!/usr/bin/env python3
"""Reproduce the offline Mermaid asset without executing upstream install scripts.

Requires Python 3 and the project's Node/npm runtime on PATH. The normal command
compares the rebuilt bytes with the checked-in asset; --write replaces that asset
when deliberately refreshing it. Runtime npm setup does not run this tool.
"""

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request


SOURCES = (
    (
        "source",
        "https://codeload.github.com/mermaid-js/mermaid/tar.gz/refs/tags/mermaid%4011.17.2",
        "eec801b8998fcff16f665b44c6dd1ebe716746b9e078f86a8694b04b5a2b0118",
    ),
    (
        "mermaid",
        "https://registry.npmjs.org/mermaid/-/mermaid-11.17.2.tgz",
        "6ad2f42c3fc26bbf9e45cbb6d11898972573ea52b33a5f4ff51952899f950ffd",
    ),
    (
        "parser",
        "https://registry.npmjs.org/@mermaid-js/parser/-/parser-1.2.1.tgz",
        "97eef1a4c37110e4836b6eb8dd6a348d989efb370a7672831df01042a7c323f4",
    ),
)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write_source(work, package, name, content):
    parts = PurePosixPath(name).parts
    if not parts or parts[0] != "src" or ".." in parts or "\\" in name:
        raise ValueError("Unsafe source path in upstream input")
    target = work / "packages" / package / Path(*parts)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)


def prepare_sources(work):
    originals = []
    for package, url, expected in SOURCES:
        request = urllib.request.Request(url, headers={"User-Agent": "ThreadShelf-renderer-rebuild"})
        with urllib.request.urlopen(request, timeout=60) as response:
            data = response.read(80 * 1024 * 1024 + 1)
        if len(data) > 80 * 1024 * 1024 or digest(data) != expected:
            raise ValueError(f"Upstream archive integrity failed: {package}")
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            for member in archive:
                if not member.isfile():
                    continue
                if package == "source":
                    relative = member.name.split("/", 1)[-1]
                    for component in ("mermaid", "parser"):
                        prefix = f"packages/{component}/"
                        if relative.startswith(prefix + "src/") and not any(
                            excluded in relative for excluded in ("/docs/", "/__snapshots__/", ".test.", ".spec.")
                        ):
                            originals.append((component, relative[len(prefix):], archive.extractfile(member).read()))
                    continue
                if not member.name.startswith("package/dist/") or not member.name.endswith(".map"):
                    continue
                if package == "mermaid" and member.name != "package/dist/mermaid.min.js.map":
                    continue
                source_map = json.load(archive.extractfile(member))
                for name, content in zip(source_map["sources"], source_map["sourcesContent"]):
                    if content is not None and re.match(r"^(\.\./)+src/", name):
                        name = re.sub(r"^(\.\./)+", "", name)
                        target = work / "packages" / package / name
                        encoded = content.encode("utf-8")
                        if target.exists() and target.read_bytes() != encoded:
                            raise ValueError(f"Conflicting upstream generated source: {name}")
                        write_source(work, package, name, encoded)
    # Source maps retain generated Jison, schema, and Langium inputs. Original
    # sources supply omitted re-export/type modules, without regenerating parsers.
    for package, name, content in originals:
        if not (work / "packages" / package / name).exists():
            write_source(work, package, name, content)


def rebuild(root, work, write):
    prepare_sources(work)
    recipe = root / "scripts/renderer-build"
    for name in ("package.json", "package-lock.json", "build.mjs"):
        shutil.copyfile(recipe / name, work / name)
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    node = shutil.which("node")
    if not npm or not node:
        raise RuntimeError("Put the project-local Node/npm runtime on PATH first.")
    major = int(subprocess.check_output([node, "-p", "process.versions.node.split('.')[0]"], text=True).strip())
    if major < 24:
        raise RuntimeError("Node 24 or newer is required.")
    env = os.environ.copy()
    env.setdefault("npm_config_cache", str(work / "npm-cache"))
    subprocess.run([npm, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], cwd=work, env=env, check=True)
    subprocess.run([node, "build.mjs"], cwd=work, env=env, check=True)
    output = (work / "output/mermaid.min.js").read_bytes()
    target = root / "client/public/renderer/mermaid.min.js"
    if write:
        target.write_bytes(output)
        print("Updated Mermaid asset. Refresh dependency inventory, notices, and hashes before release.")
    elif output != target.read_bytes():
        raise ValueError("Rebuilt Mermaid bytes differ from the checked-in asset.")
    else:
        manifest = json.loads((root / "client/src/enhanced-renderer/licenses/dependencies.json").read_text())
        mathjax_names = {"mathjax", "mathjax-full", "speech-rule-engine", "mj-context-menu"}
        expected = {(p["name"], p["version"]) for p in manifest["packages"] if p["name"] not in mathjax_names}
        actual = {(p["name"], p["version"]) for p in json.loads((work / "output/packages.json").read_text())}
        if actual != expected:
            raise ValueError(f"Mermaid inventory differs: added={sorted(actual - expected)}, missing={sorted(expected - actual)}")
        print(f"Mermaid inventory verified: {len(actual)} embedded package versions")
    print(f"Mermaid rebuild verified: {digest(output)} ({len(output)} bytes)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="replace the checked-in Mermaid asset")
    parser.add_argument("--work-dir", type=Path, help="new empty directory to retain build evidence")
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    if args.work_dir:
        if args.work_dir.exists() and any(args.work_dir.iterdir()):
            raise ValueError("--work-dir must be empty")
        args.work_dir.mkdir(parents=True, exist_ok=True)
        rebuild(root, args.work_dir.resolve(), args.write)
    else:
        with tempfile.TemporaryDirectory(prefix="threadshelf-renderer-") as temporary:
            rebuild(root, Path(temporary), args.write)


if __name__ == "__main__":
    main()
