import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { before, after } from "node:test";
import { chromium } from "playwright";
import ts from "typescript";

let browser;
let page;
before(async () => {
    browser = await chromium.launch({
        headless: true,
        executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
        args: ["--no-sandbox"],
    });
    page = await browser.newPage({ viewport: { width: 400, height: 800 } });
});
after(async () => { await browser?.close(); });

async function render(body, setup = "") {
    await page.setContent(`<style>
        body { margin: 0; }
        .layer { position: absolute; inset: 0; background: white; }
        button { width: 60px; height: 40px; }
        .modal-overlay, .rb-modal-mask, .xhs-modal-backdrop, .chat-html-overlay, .music-settings-modal-overlay { position: absolute; inset: 0; background: #888; z-index: 1000; }
        .dialog { position: absolute; inset: 100px 20px; background: white; }
    </style>${body}`);
    const source = await readFile(new URL("../lib/android-back-navigation.ts", import.meta.url), "utf8");
    const { outputText } = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    await page.addScriptTag({ type: "module", content: `${outputText}\nwindow.back = () => handleAndroidBack(document);` });
    await page.evaluate(setup);
}

test("each gesture returns just the exposed page, preserving the chat and list below it", async () => {
    await render(`
        <div id="list" class="layer"><button aria-label="返回">桌面</button></div>
        <div id="chat" class="layer" style="z-index:20"><button aria-label="返回">列表</button></div>
        <div id="settings" class="layer" style="z-index:50"><button aria-label="返回">聊天</button></div>
    `, `document.querySelectorAll('button').forEach(button => button.onclick = () => button.parentElement.remove())`);
    assert.equal(await page.evaluate(() => window.back()), true);
    assert.deepEqual(await page.locator(".layer").evaluateAll(nodes => nodes.map(node => node.id)), ["list", "chat"]);
    assert.equal(await page.evaluate(() => window.back()), true);
    assert.deepEqual(await page.locator(".layer").evaluateAll(nodes => nodes.map(node => node.id)), ["list"]);
});

test("a confirmation cancels without confirming or returning the page underneath", async () => {
    await render(`
        <div id="chat" class="layer"><button aria-label="返回">列表</button></div>
        <div class="modal-overlay"><div class="dialog" onclick="event.stopPropagation()">
            <button id="cancel">取消</button><button id="delete">删除</button>
        </div></div>
    `, `
        window.deleted = false;
        document.querySelector('#delete').onclick = () => window.deleted = true;
        document.querySelector('#cancel').onclick = () => document.querySelector('.modal-overlay').remove();
        document.querySelector('#chat button').onclick = () => document.querySelector('#chat').remove();
    `);
    assert.equal(await page.evaluate(() => window.back()), true);
    assert.equal(await page.evaluate(() => window.deleted), false);
    assert.equal(await page.locator("#chat").count(), 1);
    assert.equal(await page.locator(".modal-overlay").count(), 0);
});

test("a nested dialog closes only the front dialog even when its parent also has a back button", async () => {
    await render(`
        <div class="modal-overlay" id="outer"><div class="dialog" onclick="event.stopPropagation()">
            <button aria-label="返回">上一步</button>
            <div class="modal-overlay" id="inner"><div class="dialog" onclick="event.stopPropagation()"><button>取消</button></div></div>
        </div></div>
    `, `
        document.querySelector('#outer button').onclick = () => document.querySelector('#outer').remove();
        document.querySelector('#inner button').onclick = () => document.querySelector('#inner').remove();
    `);
    assert.equal(await page.evaluate(() => window.back()), true);
    assert.equal(await page.locator("#outer").count(), 1);
    assert.equal(await page.locator("#inner").count(), 0);
});

test("a reality bridge wizard returns one step before closing the editor", async () => {
    await render(`<div class="rb-modal-mask"><div class="dialog" onclick="event.stopPropagation()">
        <button aria-label="上一步">上一步</button>
    </div></div>`, `
        window.step = 3;
        document.querySelector('button').onclick = () => window.step -= 1;
        document.querySelector('.rb-modal-mask').onclick = () => document.querySelector('.rb-modal-mask').remove();
    `);
    assert.equal(await page.evaluate(() => window.back()), true);
    assert.equal(await page.evaluate(() => window.step), 2);
    assert.equal(await page.locator(".rb-modal-mask").count(), 1);
});

test("a dismissible backdrop closes when there is no explicit cancel control", async () => {
    await render(`<div class="rb-modal-mask"><div class="dialog" onclick="event.stopPropagation()">桥接设置</div></div>`,
        `document.querySelector('.rb-modal-mask').onclick = () => document.querySelector('.rb-modal-mask').remove()`);
    assert.equal(await page.evaluate(() => window.back()), true);
    assert.equal(await page.locator(".rb-modal-mask").count(), 0);
});

test("a busy dialog consumes back without clicking a disabled cancel or the page below", async () => {
    await render(`
        <div id="chat" class="layer"><button aria-label="返回">列表</button></div>
        <div class="modal-overlay"><div class="dialog" onclick="event.stopPropagation()"><button disabled>取消</button></div></div>
    `, `document.querySelector('#chat button').onclick = () => document.querySelector('#chat').remove()`);
    assert.equal(await page.evaluate(() => window.back()), true);
    assert.equal(await page.locator("#chat").count(), 1);
    assert.equal(await page.locator(".modal-overlay").count(), 1);
});

test("hidden cached rooms do not intercept back at the desktop", async () => {
    await render(`<div style="display:none"><div class="modal-overlay"><button>取消</button></div><button aria-label="返回">返回</button></div>`);
    assert.equal(await page.evaluate(() => window.back()), false);
});

test("visual stacking wins over DOM order and decorative buttons do not act as back", async () => {
    await render(`
        <div class="layer" id="top" style="z-index:50"><button aria-label="返回">返回</button></div>
        <div class="layer" id="bottom"><button aria-label="返回">返回</button></div>
    `, `document.querySelectorAll('button').forEach(button => button.onclick = () => button.parentElement.remove())`);
    assert.equal(await page.evaluate(() => window.back()), true);
    assert.equal(await page.locator("#top").count(), 0);
    assert.equal(await page.locator("#bottom").count(), 1);
    await render(`<button class="page-back-btn" aria-label="更多">更多</button>`);
    assert.equal(await page.evaluate(() => window.back()), false);
});

test("a subpage's named return goes to its parent rather than closing the app", async () => {
    await render(`
        <div id="app" class="layer"><button aria-label="返回桌面">桌面</button></div>
        <div id="thread" class="layer" style="z-index:20"><button aria-label="返回消息">消息列表</button></div>
    `, `document.querySelectorAll('button').forEach(button => button.onclick = () => button.parentElement.remove())`);
    assert.equal(await page.evaluate(() => window.back()), true);
    assert.equal(await page.locator("#thread").count(), 0);
    assert.equal(await page.locator("#app").count(), 1);
});

test("the existing Xiaohongshu editor backdrop consumes back before the app", async () => {
    await render(`
        <div id="app" class="layer"><button aria-label="返回桌面">桌面</button></div>
        <div class="xhs-modal-backdrop"><div class="dialog" onclick="event.stopPropagation()">编辑笔记</div></div>
    `, `
        document.querySelector('.xhs-modal-backdrop').onclick = () => document.querySelector('.xhs-modal-backdrop').remove();
        document.querySelector('#app button').onclick = () => document.querySelector('#app').remove();
    `);
    assert.equal(await page.evaluate(() => window.back()), true);
    assert.equal(await page.locator(".xhs-modal-backdrop").count(), 0);
    assert.equal(await page.locator("#app").count(), 1);
});

for (const className of ["chat-html-overlay", "music-settings-modal-overlay"]) {
    test(`an existing ${className} cancels editing without saving or leaving the app`, async () => {
        await render(`
            <div id="app" class="layer"><button aria-label="返回">返回</button></div>
            <div class="${className}"><div class="dialog" onclick="event.stopPropagation()">
                <button id="cancel">取消</button><button id="save">保存</button>
            </div></div>
        `, `
            window.saved = false;
            document.querySelector('#save').onclick = () => window.saved = true;
            document.querySelector('#cancel').onclick = () => document.querySelector('.${className}').remove();
            document.querySelector('#app button').onclick = () => document.querySelector('#app').remove();
        `);
        assert.equal(await page.evaluate(() => window.back()), true);
        assert.equal(await page.evaluate(() => window.saved), false);
        assert.equal(await page.locator(`.${className}`).count(), 0);
        assert.equal(await page.locator("#app").count(), 1);
    });
}

test("a marked desktop drawer closes before the surrounding edit mode", async () => {
    await render(`
        <div id="desktop"><div id="drawer" class="layer"><button data-float-back aria-label="关闭添加组件">✕</button></div></div>
    `, `
        window.editing = true;
        document.querySelector('#drawer button').onclick = () => document.querySelector('#drawer').remove();
    `);
    assert.equal(await page.evaluate(() => window.back()), true);
    assert.equal(await page.locator("#drawer").count(), 0);
    assert.equal(await page.evaluate(() => window.editing), true);
    assert.equal(await page.evaluate(() => window.back()), false);
});

test("the music back handler leaves a playlist before closing its app", async () => {
    await render(`<div id="music" class="layer"><button class="music-header-action" aria-label="返回">返回</button></div>`, `
        window.playlist = '每日推荐';
        document.querySelector('button').onclick = () => {
            if (window.playlist) window.playlist = null;
            else document.querySelector('#music').remove();
        };
    `);
    assert.equal(await page.evaluate(() => window.back()), true);
    assert.equal(await page.evaluate(() => window.playlist), null);
    assert.equal(await page.locator("#music").count(), 1);
    assert.equal(await page.evaluate(() => window.back()), true);
    assert.equal(await page.locator("#music").count(), 0);
});
