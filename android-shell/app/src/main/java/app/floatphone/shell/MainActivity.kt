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
        const val VERSION = "1.0.4"
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
                }
            }

            override fun onPageFinished(view: WebView, url: String) {
                super.onPageFinished(view, url)
                if (Uri.parse(url).host == Uri.parse(SITE_URL).host) {
                    forceShellMobileLayout(view)
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
  position: relative !important;
  top: calc(-1 * var(--mobile-keyboard-lift, 0px));
  transform: none !important;
  -webkit-transform: none !important;
  will-change: auto !important;
  transition: top 0.18s cubic-bezier(0.22, 1, 0.36, 1);
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

/* Huawei WebView 114 在 fixed 弹窗 + transformed ancestor/动画合成层下会出现
   局部不重绘。APK 壳不需要这层动画，优先保证整块弹窗稳定绘制。 */
html[data-float-shell-mobile="1"] .modal-overlay,
html[data-float-shell-mobile="1"] [data-ui="modal"] {
  position: fixed !important;
  inset: 0 !important;
  width: auto !important;
  height: auto !important;
  transform: none !important;
  -webkit-transform: none !important;
  will-change: auto !important;
  animation: none !important;
}
html[data-float-shell-mobile="1"] .modal-dialog,
html[data-float-shell-mobile="1"] .modal-sheet,
html[data-float-shell-mobile="1"] .modal-expand,
html[data-float-shell-mobile="1"] [data-ui="modal-dialog"] {
  box-sizing: border-box !important;
  transform: none !important;
  -webkit-transform: none !important;
  will-change: auto !important;
  animation: none !important;
}
html[data-float-shell-mobile="1"] [aria-modal="true"] {
  will-change: auto !important;
  animation: none !important;
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
