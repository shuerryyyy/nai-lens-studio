"""PWA regression checks (Python Playwright + installed Chromium or WebKit)."""
import argparse
import base64
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from tempfile import TemporaryDirectory
from threading import Thread

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMB/6kCtkAAAAAASUVORK5CYII="
SYNTHETIC = {
    "recipes": [{"id": "recipe-test", "name": "测试配方", "artistPrompt": "test artist"}],
    "characters": [{"id": "character-test", "name": "测试人物", "fullPrompt": "test character"}],
    "words": [{"id": "word-test", "kind": "scene", "name": "测试散词", "content": "test scene"}],
    "collections": [{"id": "folder-test", "libraryType": "artworks", "name": "测试文件夹"}],
    "artworks": [{"id": 1, "blob": f"data:image/png;base64,{PIXEL}", "recipeId": "recipe-test",
                  "characterIds": ["character-test"], "exampleWordIds": ["word-test"], "folderId": "folder-test"}],
    "vibeRecords": [{"id": "vibe-test", "type": "asset", "name": "测试 Vibe",
                     "image": f"data:image/png;base64,{PIXEL}"}],
}


class StaticServer(SimpleHTTPRequestHandler):
    def do_GET(self):
        if getattr(self.server, "drop_requests", False):
            self.close_connection = True
        else:
            super().do_GET()

    def log_message(self, *_):
        pass

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_POST(self):
        self.send_response(204)
        self.end_headers()


def import_backup(page, data):
    page.locator("#importFile").set_input_files(
        {"name": "test.json", "mimeType": "application/json", "buffer": json.dumps(data).encode()}
    )
    page.locator("#confirmRestorePreview").click()
    page.wait_for_function("""() => !document.getElementById('restorePreviewDialog').open ||
      document.getElementById('toast').textContent.startsWith('恢复失败：')""")
    assert not page.locator("#restorePreviewDialog").is_visible(), page.locator("#toast").inner_text()


def verify_records(page):
    records = page.evaluate("""async () => {
      const [artwork] = await dbAll('artworks');
      const [recipe] = await dbAll('recipes');
      const [folder] = await dbAll('collections');
      const [vibe] = await dbAll('vibes');
      const [character] = characters();
      const [word] = words();
      return {
        counts: [(await dbAll('artworks')).length, (await dbAll('recipes')).length, characters().length, words().length],
        names: [recipe.name, character.name, word.name, folder.name, vibe.name],
        links: [artwork.recipeId === recipe.id, artwork.characterIds.includes(character.id),
                artwork.exampleWordIds.includes(word.id), artwork.folderId === folder.id],
        png: Array.from(new Uint8Array(await artwork.blob.arrayBuffer())),
        credentials: [Boolean(document.querySelector('#token').value), apiPresets().length]
      };
    }""")
    assert records["counts"] == [1, 1, 1, 1], records
    assert records["names"] == ["测试配方", "测试人物", "测试散词", "测试文件夹", "测试 Vibe"], records
    assert all(records["links"]), records
    assert bytes(records["png"]) == base64.b64decode(PIXEL)
    return records


def open_app(page, url):
    page.goto(url)
    page.wait_for_function("document.documentElement.dataset.stage === 'ready'")


def install_worker(page):
    page.wait_for_function("document.getElementById('pwaOffline').textContent.includes('离线文件已就绪')")
    page.reload()
    page.wait_for_function("navigator.serviceWorker.controller && document.documentElement.dataset.stage === 'ready'")


def exercise(browser, engine, url, fixture):
    context = browser.new_context(accept_downloads=True)
    # Start with the previous release at the same origin, then publish the new files.
    page = context.new_page()
    errors = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    open_app(page, url)
    import_backup(page, SYNTHETIC)
    verify_records(page)
    page.evaluate("""() => {
      document.getElementById('rememberToken').checked = true;
      document.getElementById('token').value = 'synthetic-token-for-tests';
      saveSettings();
    }""")
    for name in ("index.html", "assets/nai-generation.js", "assets/nai-vibes.js"):
        shutil.copyfile(ROOT / name, fixture / name)
    open_app(page, url)
    install_worker(page)
    assert verify_records(page)["credentials"][0]
    if engine == "chromium":
        cdp = context.new_cdp_session(page)
        manifest = cdp.send("Page.getAppManifest")
        assert not manifest["errors"] and manifest["data"], manifest
        assert cdp.send("Page.getInstallabilityErrors")["installabilityErrors"] == []
        assert json.loads(manifest["data"])["display"] == "standalone"
    print("PASS  Pages scope, offline worker, existing same-origin data and Chromium manifest check where available")

    assets = page.evaluate("""async () => Array.from(
      await (await caches.open((await caches.keys()).find(name => name.startsWith('nai-lens-shell:')))).keys(),
      request => request.url
    )""")
    assert len(assets) >= 24 and all(asset.startswith(url) for asset in assets), assets
    assert all("/download/" not in asset and "synthetic-token" not in asset for asset in assets), assets
    # Fetch an allowlisted asset as an API response, plus arbitrary private GET and POST URLs.
    for path, options in [
        ("assets/pwa.css", {"cache": "no-store", "headers": {"Authorization": "Bearer synthetic"}}),
        ("assets/pwa.css", {}),
        ("assets/pwa.css?private=synthetic", {}),
        ("api/generate", {"method": "POST", "body": "synthetic"}),
    ]:
        from_worker = page.evaluate("""async ([path, options]) => {
          await fetch(path, options);
          const entries = performance.getEntriesByName(new URL(path, location.href).href);
          return entries.at(-1)?.workerStart;
        }""", [path, options])
        if engine == "chromium":
            # Reading Resource Timing synchronously with fetch can see an earlier stylesheet entry.
            if path != "assets/pwa.css":
                assert not from_worker, (path, from_worker)
    context.set_offline(True)
    open_app(page, url)
    records = verify_records(page)
    assert records["credentials"][0]
    assert not page.evaluate("fetch('./assets/pwa.css', { cache: 'no-store' }).then(() => true, () => false)")
    assert not page.evaluate("fetch('./assets/pwa.css').then(() => true, () => false)")
    assert not page.evaluate("fetch('./api/generate', { method: 'POST' }).then(() => true, () => false)")
    page.locator("#exportBtn").click()
    page.wait_for_function("document.getElementById('backupSummary').textContent.includes('1 张')")
    with page.expect_download() as download_info:
        page.locator("#backupSubmitBtn").click()
    backup = json.loads(Path(download_info.value.path()).read_text())
    assert "synthetic-token" not in json.dumps(backup)
    assert not errors, errors
    context.set_offline(False)
    isolated = browser.new_context(accept_downloads=True)
    target = isolated.new_page()
    open_app(target, url)
    assert target.evaluate("Promise.all([dbAll('artworks'), dbAll('recipes')]).then(stores => stores.every(store => !store.length))")
    import_backup(target, backup)
    import_backup(target, backup)
    assert verify_records(target)["credentials"] == [False, 0]
    isolated.close()
    print("PASS  offline originals and links, API bypass, full backup into isolated storage, repeat restore without duplicates")

    (fixture / "index.html").write_text((ROOT / "index.html").read_text().replace("</title>", " PWA update</title>"))
    # Delay the corrected shell metadata until the integrity failure has been observed.
    (fixture / "pwa-shell.js").write_bytes((ROOT / "pwa-shell.js").read_bytes().replace(b'Generated by', b'Updated by'))
    failed_install = page.evaluate("""async () => {
      const reg = await navigator.serviceWorker.getRegistration();
      const terminalState = new Promise(resolve => {
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          worker.addEventListener('statechange', () => {
            if (['installed', 'redundant'].includes(worker.state)) resolve(worker.state);
          });
        }, { once: true });
      });
      await reg.update();
      return Promise.race([
        terminalState,
        new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))
      ]);
    }""")
    assert failed_install == "redundant", failed_install
    context.set_offline(True)
    open_app(page, url)
    original_title = page.title()
    assert "PWA update" not in original_title
    verify_records(page)
    context.set_offline(False)
    subprocess.run([sys.executable, str(fixture / "tools/pwa-shell.py")], check=True)
    other = context.new_page()
    open_app(other, url + "index.html")
    page.evaluate("navigator.serviceWorker.getRegistration().then(reg => reg.update()).catch(() => {})")
    page.wait_for_function("document.getElementById('pwaOffline').textContent.includes('新版已就绪')")
    assert other.title() == original_title
    assert page.title() == original_title
    other.close()
    page.close()
    page = context.new_page()
    open_app(page, url)
    page.wait_for_function("document.title.includes('PWA update')")
    verify_records(page)
    assert page.evaluate("(async () => (await caches.keys()).filter(name => name.startsWith('nai-lens-shell:')).length)()") == 1
    context.close()
    print("PASS  mixed-release rejection, waiting update, activation, obsolete shell cleanup")


def mobile(browser, devices, url):
    for name in ("Pixel 7", "iPhone 13", "iPad Mini"):
        options = devices[name]
        context = browser.new_context(**options)
        context.add_init_script("""Object.defineProperty(navigator, 'standalone', { value: true });
          let heightReduction = 0;
          const viewport = visualViewport;
          const readHeight = Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'height').get;
          Object.defineProperty(viewport, 'height', { get: () => readHeight.call(viewport) - heightReduction });
          window.mockKeyboard = size => { heightReduction = size; viewport.dispatchEvent(new Event('resize')); };
        """)
        page = context.new_page()
        width, height = options["viewport"].values()
        open_app(page, url)
        assert page.locator("html[data-standalone]").count() == 1
        page.evaluate("""() => {
          const root = document.documentElement;
          for (const [edge, size] of Object.entries({ top: 12, left: 20, right: 20, bottom: 16 })) {
            root.style.setProperty('--safe-' + edge, size + 'px');
          }
        }""")
        for viewport in ((width, height), (height, width)):
            page.set_viewport_size(dict(zip(("width", "height"), viewport)))
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
            page.evaluate("document.getElementById('wordEditorDialog').showModal()")
            page.locator("#wordName").focus()
            page.evaluate("mockKeyboard(150)")
            assert page.locator("html[data-keyboard-open=true]").count() == 1
            editor = page.locator("#wordEditorDialog").bounding_box()
            assert editor["x"] >= 19 and editor["y"] >= 11, editor
            assert editor["height"] <= viewport[1] - 150 - 27, editor
            assert editor["x"] + editor["width"] <= viewport[0] - 19, editor
            page.evaluate("mockKeyboard(0)")
            assert page.locator("html[data-keyboard-open=false]").count() == 1
            page.evaluate("document.getElementById('wordEditorDialog').close()")
        context.close()
    print("PASS  mobile portrait/landscape layouts, synthetic safe areas and keyboard in standalone mode")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--engine", default="chromium", choices=("chromium", "webkit"))
    parser.add_argument("--smoke-only", action="store_true", help="Check startup, offline, and layouts without migrating data")
    args = parser.parse_args()
    with TemporaryDirectory() as temporary, sync_playwright() as playwright:
        fixture = Path(temporary) / "nai-lens-studio"
        shutil.copytree(ROOT, fixture, ignore=shutil.ignore_patterns(".git", "screenshots"))
        if not args.smoke_only:
            for name in ("index.html", "assets/nai-generation.js", "assets/nai-vibes.js"):
                previous = subprocess.check_output(["git", "show", f"v2.32.2:{name}"], cwd=ROOT)
                (fixture / name).write_bytes(previous)
        server = ThreadingHTTPServer(("127.0.0.1", 0), partial(StaticServer, directory=temporary))
        Thread(target=server.serve_forever, daemon=True).start()
        url = f"http://127.0.0.1:{server.server_port}/nai-lens-studio/"
        options = {}
        if args.engine == "chromium":
            options["executable_path"] = os.environ.get("CHROMIUM_PATH")
        browser = getattr(playwright, args.engine).launch(**options)
        try:
            if args.smoke_only:
                context = browser.new_context()
                page = context.new_page()
                open_app(page, url)
                install_worker(page)
                print("PASS  application and service worker start under Pages subpath")
                server.drop_requests = True
                open_app(page, url)
                assert not page.evaluate("fetch('./api/unreachable').then(() => true, () => false)")
                server.drop_requests = False
                context.close()
                print("PASS  shell starts when the HTTP server cannot respond")
            else:
                exercise(browser, args.engine, url, fixture)
            mobile(browser, playwright.devices, url)
            context = browser.new_context()
            page = context.new_page()
            open_app(page, (ROOT / "download/nai-lens-studio-v2.32.2-standalone.html").as_uri())
            assert page.locator("link[rel=manifest]").count() == 0
            print("PASS  downloadable HTML opens via file://")
            context.close()
        finally:
            browser.close()
            server.shutdown()


if __name__ == "__main__":
    main()
