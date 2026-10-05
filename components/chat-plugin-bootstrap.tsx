"use client";

// components/chat-plugin-bootstrap.tsx
// 聊天插件运行时启动引导：应用挂载后加载全部启用插件。
// 本机数据完整加载后由 MainApp 挂载，在用户进入聊天前注册 hook。

import { useEffect } from "react";
import { getChatPluginRuntime } from "@/lib/chat-plugin-runtime";

export function ChatPluginBootstrap() {
    useEffect(() => {
        void getChatPluginRuntime().ensureStarted();
    }, []);
    return null;
}
