package app.floatphone.shell

import android.Manifest
import android.annotation.SuppressLint
import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.Settings
import android.webkit.CookieManager
import android.webkit.DownloadListener
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowCompat

/**
 * Float 小手机安卓壳：全屏 WebView 直接加载线上站点。
 * 网页每次部署即时生效，本壳只负责原生能力（推送长连接、文件上下行、外链）。
 */
class MainActivity : AppCompatActivity() {

    companion object {
        val SITE_URL: String = BuildConfig.SITE_URL
        const val VERSION = "1.0.6"
        /** 来电接听等场景的站内深链（必须以 SITE_URL 开头，否则忽略） */
        const val EXTRA_OPEN_URL = "open_url"
    }

    private lateinit var webView: WebView
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private var backRequestPending = false

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val callback = filePathCallback ?: return@registerForActivityResult
        filePathCallback = null
        val data = result.data?.data
        callback.onReceiveValue(if (data != null) arrayOf(data) else emptyArray())
    }

    private val notifPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { granted ->
        if (granted) PushService.start(this)
    }

    // 网页侧 getUserMedia（通话按住说话、语音条录音、视频通话摄像头）触发的
    // WebView 权限请求：先要系统运行时权限，拿到后再转授给页面。
    // 不实现 onPermissionRequest 时 WebView 会静默拒绝，页面永远拿不到麦克风。
    private var pendingWebPermissionRequest: android.webkit.PermissionRequest? = null

    private val webPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions()
    ) { _ ->
        val request = pendingWebPermissionRequest ?: return@registerForActivityResult
        pendingWebPermissionRequest = null
        val granted = request.resources.filter { resource ->
            webResourcePermissions(resource).all {
                ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
            }
        }
        if (granted.isEmpty()) request.deny() else request.grant(granted.toTypedArray())
    }

    private fun webResourcePermissions(resource: String): List<String> = when (resource) {
        android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE -> listOf(Manifest.permission.RECORD_AUDIO)
        android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE -> listOf(Manifest.permission.CAMERA)
        else -> emptyList()
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, true)
        // 音量键默认调媒体流：WebView 里的语音条/TTS 都走媒体流播放，
        // 不设的话短音频没在播时按键调的是铃声，用户感觉"音量键无效、声音巨大"
        volumeControlStream = AudioManager.STREAM_MUSIC

        webView = WebView(this)
        setContentView(webView)

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            mediaPlaybackRequiresUserGesture = false
            allowFileAccess = false
            userAgentString = "$userAgentString FloatShell/$VERSION"
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false)

        webView.addJavascriptInterface(ShellBridge(), "AndroidShell")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url
                val scheme = url.scheme ?: return false
                // 站内导航留在壳里；http(s) 外链和自定义协议（shortcuts:// 等）交给系统
                if (scheme == "http" || scheme == "https") {
                    if (url.host == Uri.parse(SITE_URL).host) return false
                    return runCatching {
                        startActivity(Intent(Intent.ACTION_VIEW, url)); true
                    }.getOrDefault(true)
                }
                return runCatching {
                    startActivity(Intent(Intent.ACTION_VIEW, url)); true
                }.getOrDefault(true)
            }

            override fun onPageCommitVisible(view: WebView, url: String) {
                super.onPageCommitVisible(view, url)
                if (Uri.parse(url).host == Uri.parse(SITE_URL).host) {
                    forceShellMobileLayout(view)
                    installShellKeyboardAnchor(view)
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                if (Uri.parse(url).host == Uri.parse(SITE_URL).host) {
                    forceShellMobileLayout(view)
                    installShellKeyboardAnchor(view)
                    syncPersonalPushConfig(view)
                    cleanLegacyPwaState(view)
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
                val supported = request.resources.filter { webResourcePermissions(it).isNotEmpty() }
                if (supported.isEmpty()) { request.deny(); return }
                val missing = supported.flatMap { webResourcePermissions(it) }
                    .distinct()
                    .filter { ContextCompat.checkSelfPermission(this@MainActivity, it) != PackageManager.PERMISSION_GRANTED }
                if (missing.isEmpty()) { request.grant(supported.toTypedArray()); return }
                if (pendingWebPermissionRequest != null) { request.deny(); return }
                pendingWebPermissionRequest = request
                webPermissionLauncher.launch(missing.toTypedArray())
            }

            override fun onShowFileChooser(
                view: WebView,
                callback: ValueCallback<Array<Uri>>,
                params: FileChooserParams,
            ): Boolean {
                filePathCallback?.onReceiveValue(emptyArray())
                filePathCallback = callback
                return runCatching {
                    fileChooserLauncher.launch(params.createIntent()); true
                }.getOrElse {
                    filePathCallback = null; false
                }
            }
        }

        // 备份导出等下载：交给系统下载管理器，落到公共下载目录
        webView.setDownloadListener(DownloadListener { url, userAgent, contentDisposition, mimeType, _ ->
            runCatching {
                if (url.startsWith("blob:") || url.startsWith("data:")) {
                    // blob/data 由页面内 JS 触发的 a[download] 处理；提示用户等待
                    Toast.makeText(this, "正在导出…", Toast.LENGTH_SHORT).show()
                    return@DownloadListener
                }
                val request = DownloadManager.Request(Uri.parse(url)).apply {
                    addRequestHeader("User-Agent", userAgent)
                    addRequestHeader("Cookie", CookieManager.getInstance().getCookie(url) ?: "")
                    setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    setDestinationInExternalPublicDir(
                        Environment.DIRECTORY_DOWNLOADS,
                        android.webkit.URLUtil.guessFileName(url, contentDisposition, mimeType),
                    )
                }
                (getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager).enqueue(request)
                Toast.makeText(this, "已开始下载到「下载」目录", Toast.LENGTH_SHORT).show()
            }
        })

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (backRequestPending) return
                backRequestPending = true
                // SPA 内部页面不在 WebView 历史里，先交给网页当前最上层的返回按钮。
                webView.evaluateJavascript(
                    """(function() {
                        if (typeof window.floatHandleBack !== 'function') return null;
                        return window.floatHandleBack();
                    })()""".trimIndent()
                ) { result ->
                    backRequestPending = false
                    if (isFinishing || isDestroyed) return@evaluateJavascript
                    when (result) {
                        "true" -> Unit // 网页只关闭/返回了一层，不再额外 goBack。
                        "false" -> moveTaskToBack(true) // 已在 float 桌面。
                        else -> { // 兼容尚未部署网页返回桥的旧版本。
                            if (webView.canGoBack()) webView.goBack() else moveTaskToBack(true)
                        }
                    }
                }
            }
        })

        // 冷启动带深链（如来电接听）直接加载目标；否则加载首页
        webView.loadUrl(consumeOpenUrl(intent) ?: SITE_URL)
        ensurePushService()
    }

    /** singleTask：App 已在运行时（如全屏来电页接听）通过 onNewIntent 送达深链 */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val target = consumeOpenUrl(intent) ?: return
        // SPA 已加载：loadUrl 到同页 hash 只触发 hashchange，不会整页重载
        webView.loadUrl(target)
    }

    private fun consumeOpenUrl(intent: Intent?): String? {
        val target = intent?.getStringExtra(EXTRA_OPEN_URL) ?: return null
        intent.removeExtra(EXTRA_OPEN_URL)
        return target.takeIf { it.startsWith(SITE_URL) }
    }

    /**
     * Huawei WebView 114 不可靠地报告 hover/pointer media features，导致网页的
     * @media (hover: none) and (pointer: coarse) 移动布局完全不命中。壳环境本身
     * 已经确定是手机，因此直接补上与网页移动端分支等价的壳布局，不再猜 media query。
     */
    private fun forceShellMobileLayout(view: WebView) {
        view.evaluateJavascript(
            """(function() {
                try {
                    var root = document.documentElement;
                    root.setAttribute('data-float-shell-mobile', '1');
                    if (document.getElementById('float-shell-mobile-layout')) return;

                    var style = document.createElement('style');
                    style.id = 'float-shell-mobile-layout';
                    style.textContent = `
html[data-float-shell-mobile="1"] {
  --phone-screen-width: 100vw;
  --phone-screen-height: 100lvh;
  overflow: hidden !important;
  width: 100% !important;
  height: 100lvh !important;
  background: var(--c-page-body-bg);
}
html[data-float-shell-mobile="1"] body {
  overflow: hidden !important;
  width: 100% !important;
  height: 100lvh !important;
  margin: 0 !important;
  background: var(--c-page-body-bg);
}
html[data-float-shell-mobile="1"] .app-root {
  width: 100vw !important;
  height: 100lvh !important;
  margin: 0 !important;
  padding: 0 !important;
  display: flex !important;
  justify-content: flex-start !important;
  align-items: flex-start !important;
  overflow: hidden !important;
  background: var(--c-page-body-bg);
}
html[data-float-shell-mobile="1"] .phone-shell-wrap {
  --phone-case-padding: 0px;
  --phone-case-border-size: 0px;
  --phone-frame-size: 0px;
  --phone-screen-radius: 0px;
  --phone-frame-radius: 0px;
  --phone-case-radius: 0px;
  width: 100vw !important;
  margin-inline: 0 !important;
  margin-top: calc(-1 * var(--status-bar-drop, 0px)) !important;
  gap: 0 !important;
  transform-origin: top left;
  transform: translate3d(0, calc(-1 * var(--mobile-keyboard-lift, 0px)), 0);
}
html[data-float-shell-mobile="1"] .phone-shell-wrap .phone-case,
html[data-float-shell-mobile="1"] .phone-shell-wrap .phone-frame {
  width: 100vw !important;
  padding: 0 !important;
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}
html[data-float-shell-mobile="1"] .phone-shell-wrap .phone-case::before,
html[data-float-shell-mobile="1"] .phone-shell-wrap .phone-case::after,
html[data-float-shell-mobile="1"] .phone-shell-wrap .phone-frame::before,
html[data-float-shell-mobile="1"] .phone-shell-wrap .phone-frame::after {
  display: none !important;
}
html[data-float-shell-mobile="1"] .phone-shell {
  width: 100vw !important;
  height: 100lvh !important;
  border-radius: 0 !important;
}
html[data-float-shell-mobile="1"] .app-root.splash-root {
  width: 100vw !important;
  height: 100lvh !important;
  margin: 0 !important;
  padding: 0 !important;
  display: flex !important;
  align-items: flex-start !important;
  justify-content: flex-start !important;
  overflow: hidden !important;
}
html[data-float-shell-mobile="1"] .splash-shell-wrap,
html[data-float-shell-mobile="1"] .splash-shell-wrap .phone-case,
html[data-float-shell-mobile="1"] .splash-shell-wrap .phone-frame {
  width: 100vw !important;
}

@media (max-width: 373px) {
  html[data-float-shell-mobile="1"] .icon-grid,
  html[data-float-shell-mobile="1"] .dock {
    --slot-size: 16.92vw;
    --slot-gap-x: 5.13vw;
    --slot-icon-width: 15.9vw;
    --slot-icon-height: 15.9vw;
  }
  html[data-float-shell-mobile="1"] .icon-glyph-box,
  html[data-float-shell-mobile="1"] .dock .dock-glyph-box {
    width: 14.87vw;
    height: 14.87vw;
  }
  html[data-float-shell-mobile="1"] .dock {
    width: min(calc((var(--dock-count) * var(--slot-size)) + ((var(--dock-count) - 1) * var(--slot-gap-x)) + 30px), calc(100% - 8px));
  }
}
`;
                    (document.head || document.documentElement).appendChild(style);
                } catch (_) {}
            })()""".trimIndent(),
            null,
        )
    }

    /**
     * 键盘弹出时，如果用户原本就在聊天底部附近，就让消息列表继续锚定到底部。
     * 只调整聊天滚动容器，不移动整个 phone shell；用户正在上翻历史时不干预。
     */
    private fun installShellKeyboardAnchor(view: WebView) {
        view.evaluateJavascript(
            """(function() {
                try {
                    if (window.__floatShellKeyboardAnchorInstalled) return;
                    window.__floatShellKeyboardAnchorInstalled = true;

                    var viewport = window.visualViewport;
                    var shouldPinBottom = false;
                    var settleTimers = [];

                    function isEditable(element) {
                        if (!element || !element.tagName) return false;
                        var tag = String(element.tagName).toUpperCase();
                        if (tag === 'TEXTAREA') return true;
                        if (tag === 'INPUT') {
                            var type = String(element.type || 'text').toLowerCase();
                            return ['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset'].indexOf(type) < 0;
                        }
                        return element.isContentEditable === true;
                    }

                    function visibleChatScroller() {
                        var el = document.querySelector('.chat-scroll-anchored');
                        if (!el) return null;
                        var rect = el.getBoundingClientRect();
                        if (rect.width <= 0 || rect.height <= 0) return null;
                        return el;
                    }

                    function isNearBottom(el) {
                        return (el.scrollHeight - el.scrollTop - el.clientHeight) < 160;
                    }

                    function clearSettleTimers() {
                        settleTimers.forEach(function(id) { window.clearTimeout(id); });
                        settleTimers = [];
                    }

                    function pinBottomOnce() {
                        if (!shouldPinBottom) return;
                        var el = visibleChatScroller();
                        if (!el) return;
                        el.scrollTop = el.scrollHeight;
                    }

                    function settleBottom() {
                        if (!shouldPinBottom) return;
                        clearSettleTimers();
                        window.requestAnimationFrame(function() {
                            pinBottomOnce();
                            window.requestAnimationFrame(pinBottomOnce);
                        });
                        settleTimers.push(window.setTimeout(pinBottomOnce, 80));
                        settleTimers.push(window.setTimeout(pinBottomOnce, 180));
                        settleTimers.push(window.setTimeout(pinBottomOnce, 320));
                    }

                    document.addEventListener('focusin', function(event) {
                        if (!isEditable(event.target)) return;
                        var el = visibleChatScroller();
                        shouldPinBottom = !!el && isNearBottom(el);
                        if (shouldPinBottom) settleBottom();
                    }, true);

                    document.addEventListener('focusout', function() {
                        window.setTimeout(function() {
                            if (!isEditable(document.activeElement)) {
                                shouldPinBottom = false;
                                clearSettleTimers();
                            }
                        }, 0);
                    }, true);

                    function handleViewportResize() {
                        if (!shouldPinBottom || !isEditable(document.activeElement)) return;
                        settleBottom();
                    }

                    if (viewport) viewport.addEventListener('resize', handleViewportResize);
                    window.addEventListener('resize', handleViewportResize);
                } catch (_) {}
            })()""".trimIndent(),
            null,
        )
    }

    /**
     * 从当前站点自己的 IndexedDB 读取个人 Supabase 推送配置并交给原生服务。
     * 这段逻辑放在 APK 内，网页无需为此重新部署；即使 Netlify 没配置共享
     * SUPABASE_* 环境变量，壳也能直连用户已经部署好的个人 Supabase。
     */
    private fun syncPersonalPushConfig(view: WebView) {
        view.evaluateJavascript(
            """(function() {
                try {
                    if (!window.AndroidShell || typeof window.AndroidShell.configurePersonalPush !== 'function') return;
                    var stateKey = 'personal_push_cloud_state_v1';
                    var backupKey = 'ai_phone_cloud_backup_config_v1';

                    function normalizeUrl(value) {
                        var text = String(value || '').trim().replace(/\/+$/, '');
                        if (!text) return '';
                        if (!/^https?:\/\//i.test(text)) text = 'https://' + text;
                        return text;
                    }

                    function markShellSubscriptionGate() {
                        try {
                            var gateKey = 'push_account_subscribed_v1';
                            var value = JSON.stringify({ subscribed: true, checkedAt: Date.now() });
                            var openGate = indexedDB.open('AiPhoneKvDB');
                            openGate.onsuccess = function() {
                                var db = openGate.result;
                                try {
                                    if (!db.objectStoreNames.contains('entries')) {
                                        db.close();
                                        return;
                                    }
                                    var readTx = db.transaction('entries', 'readonly');
                                    var readReq = readTx.objectStore('entries').get(gateKey);
                                    readReq.onsuccess = function() {
                                        var alreadySubscribed = false;
                                        try {
                                            var current = readReq.result && readReq.result.value
                                                ? JSON.parse(readReq.result.value)
                                                : null;
                                            alreadySubscribed = current && current.subscribed === true;
                                        } catch (_) {}
                                        if (alreadySubscribed) {
                                            try { db.close(); } catch (_) {}
                                            return;
                                        }
                                        try {
                                            var writeTx = db.transaction('entries', 'readwrite');
                                            writeTx.objectStore('entries').put({ key: gateKey, value: value });
                                            writeTx.oncomplete = function() {
                                                try { db.close(); } catch (_) {}
                                                var marker = 'float-shell-personal-push-gate-v1';
                                                if (sessionStorage.getItem(marker) !== '1') {
                                                    sessionStorage.setItem(marker, '1');
                                                    window.setTimeout(function() { location.reload(); }, 80);
                                                }
                                            };
                                            writeTx.onerror = function() {
                                                try { db.close(); } catch (_) {}
                                            };
                                        } catch (_) {
                                            try { db.close(); } catch (_) {}
                                        }
                                    };
                                    readReq.onerror = function() {
                                        try { db.close(); } catch (_) {}
                                    };
                                } catch (_) {
                                    try { db.close(); } catch (_) {}
                                }
                            };
                        } catch (_) {}
                    }

                    function applyConfig(stateRaw, backupRaw) {
                        try {
                            var state = stateRaw ? JSON.parse(stateRaw) : null;
                            var backup = backupRaw ? JSON.parse(backupRaw) : null;
                            if (!state || state.enabled !== true || !backup) {
                                if (typeof window.AndroidShell.clearPersonalPush === 'function') window.AndroidShell.clearPersonalPush();
                                return;
                            }
                            var url = normalizeUrl(backup.url);
                            var stateUrl = normalizeUrl(state.url);
                            var serviceKey = String(backup.key || '').trim();
                            var projectRef = '';
                            try { projectRef = new URL(url).hostname.split('.')[0] || ''; } catch (_) {}
                            if (!url || !serviceKey || stateUrl !== url || String(state.projectRef || '') !== projectRef) {
                                if (typeof window.AndroidShell.clearPersonalPush === 'function') window.AndroidShell.clearPersonalPush();
                                return;
                            }

                            var gateway = url + '/functions/v1/ai-phone-push';
                            var headers = {
                                'x-ai-phone-service-key': serviceKey,
                                'x-ai-phone-origin': location.origin
                            };
                            fetch(gateway + '?action=shell-config', { headers: headers, cache: 'no-store' })
                                .then(function(response) {
                                    return response.json().catch(function() { return {}; }).then(function(data) {
                                        if (!response.ok || !data || data.ok !== true || !data.anonKey) {
                                            throw new Error('shell config unavailable');
                                        }
                                        return data;
                                    });
                                })
                                .then(function(data) {
                                    var userId = String(data.userId || 'owner');
                                    return fetch(gateway + '?action=subscribe', {
                                        method: 'POST',
                                        headers: Object.assign({ 'Content-Type': 'application/json' }, headers),
                                        body: JSON.stringify({
                                            endpoint: 'shell:' + userId,
                                            keys: { p256dh: 'shell', auth: 'shell' }
                                        }),
                                        cache: 'no-store'
                                    }).then(function(response) {
                                        if (!response.ok) throw new Error('shell subscription failed');
                                        return {
                                            supabaseUrl: normalizeUrl(data.supabaseUrl || url),
                                            anonKey: String(data.anonKey || '').trim(),
                                            userId: userId
                                        };
                                    });
                                })
                                .then(function(config) {
                                    if (!config.supabaseUrl || !config.anonKey) return;
                                    window.AndroidShell.configurePersonalPush(
                                        config.supabaseUrl,
                                        config.anonKey,
                                        config.userId
                                    );
                                    markShellSubscriptionGate();
                                })
                                .catch(function() {
                                    // 短暂断网或边缘节点传播时保留上一次原生配置，后台服务会继续重连。
                                });
                        } catch (_) {}
                    }

                    var lsState = null;
                    var lsBackup = null;
                    try {
                        lsState = localStorage.getItem(stateKey);
                        lsBackup = localStorage.getItem(backupKey);
                    } catch (_) {}
                    if (lsState && lsBackup) {
                        applyConfig(lsState, lsBackup);
                        return;
                    }
                    if (!window.indexedDB) return;

                    var open = indexedDB.open('AiPhoneKvDB');
                    open.onsuccess = function() {
                        var db = open.result;
                        try {
                            if (!db.objectStoreNames.contains('entries')) {
                                db.close();
                                return;
                            }
                            var tx = db.transaction('entries', 'readonly');
                            var store = tx.objectStore('entries');
                            var stateReq = store.get(stateKey);
                            var backupReq = store.get(backupKey);
                            var stateValue = lsState;
                            var backupValue = lsBackup;
                            var done = 0;
                            function finish() {
                                done += 1;
                                if (done < 2) return;
                                applyConfig(stateValue, backupValue);
                                try { db.close(); } catch (_) {}
                            }
                            stateReq.onsuccess = function() {
                                stateValue = (stateReq.result && stateReq.result.value) || stateValue;
                                finish();
                            };
                            stateReq.onerror = finish;
                            backupReq.onsuccess = function() {
                                backupValue = (backupReq.result && backupReq.result.value) || backupValue;
                                finish();
                            };
                            backupReq.onerror = finish;
                        } catch (_) {
                            try { db.close(); } catch (_) {}
                        }
                    };
                } catch (_) {}
            })()""".trimIndent(),
            null,
        )
    }

    /**
     * APK 壳不使用 PWA Service Worker：原生 PushService 已负责离线消息，
     * 而旧 SW 的 cache-first 静态缓存可能让新 HTML 与旧 JS/CSS 混用。
     * 这里只清站点自己的 SW + ai-phone-pwa-* CacheStorage，不碰 Cookie、
     * localStorage、IndexedDB 或登录状态；若确实清到了旧状态，本会话只刷新一次。
     */
    private fun cleanLegacyPwaState(view: WebView) {
        view.evaluateJavascript(
            """(function() {
                try {
                    var marker = 'float-shell-pwa-cleanup-v1';
                    var alreadyReloaded = sessionStorage.getItem(marker) === '1';
                    var swCleanup = ('serviceWorker' in navigator)
                        ? navigator.serviceWorker.getRegistrations()
                            .then(function(regs) {
                                return Promise.all(regs.map(function(reg) {
                                    if (reg.scope.indexOf(location.origin + '/') !== 0) return false;
                                    return reg.unregister().catch(function() { return false; });
                                }));
                            })
                            .catch(function() { return []; })
                        : Promise.resolve([]);
                    var cacheCleanup = ('caches' in window)
                        ? caches.keys()
                            .then(function(keys) {
                                return Promise.all(keys
                                    .filter(function(key) { return key.indexOf('ai-phone-pwa-') === 0; })
                                    .map(function(key) {
                                        return caches.delete(key).catch(function() { return false; });
                                    }));
                            })
                            .catch(function() { return []; })
                        : Promise.resolve([]);
                    Promise.all([swCleanup, cacheCleanup]).then(function(groups) {
                        var changed = groups[0].some(Boolean) || groups[1].some(Boolean);
                        if (changed && !alreadyReloaded) {
                            sessionStorage.setItem(marker, '1');
                            location.reload();
                        }
                    });
                } catch (_) {}
            })()""".trimIndent(),
            null,
        )
    }

    private fun ensurePushService() {
        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED
        ) {
            notifPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        } else {
            PushService.start(this)
        }
    }

    override fun onDestroy() {
        CookieManager.getInstance().flush()
        webView.destroy()
        super.onDestroy()
    }

    /** 暴露给网页的原生桥（网页侧可用 window.AndroidShell 特性检测壳环境）。 */
    inner class ShellBridge {
        @JavascriptInterface
        fun getVersion(): String = VERSION

        /** 把个人 Supabase 推送配置同步给原生前台服务；仅保存在本应用私有目录。 */
        @JavascriptInterface
        fun configurePersonalPush(url: String, key: String, userId: String) {
            PushService.configurePersonalPush(this@MainActivity, url, key, userId)
        }

        @JavascriptInterface
        fun clearPersonalPush() {
            PushService.clearPersonalPush(this@MainActivity)
        }

        /** 打开本应用的系统设置页（引导用户关电池限制、开自启动）。 */
        @JavascriptInterface
        fun openAppSettings() {
            runCatching {
                startActivity(
                    Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }

        /** 请求忽略电池优化（保活关键一步）。 */
        @SuppressLint("BatteryLife")
        @JavascriptInterface
        fun requestIgnoreBatteryOptimization() {
            runCatching {
                startActivity(
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                )
            }
        }
    }
}
