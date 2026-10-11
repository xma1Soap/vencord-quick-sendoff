/*
 * QuickSendoff, a Vencord userplugin
 * Copyright (c) 2026 xma1Soap
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

/*
 * QuickSendoff - 底层交互工具
 * 负责：查找应用命令、发送交互、解析/提交弹窗、点击组件、等待 Flux 事件。
 * 与具体 bot 无关，fox 和 gacha 的流程都基于这里。
 *
 * 标了 [待核对] 的地方是根据 Discord 客户端行为推测的，需要开 debug 抓一次真实数据确认。
 */

import * as DataStore from "@api/DataStore";
import { Logger } from "@utils/Logger";
import { AuthenticationStore, closeAllModals, FluxDispatcher, RestAPI, SnowflakeUtils } from "@webpack/common";

export const logger = new Logger("QuickSendoff", "#e67e22");

export interface Ctx {
    guildId: string;
    channelId: string;
}

/* ---------------- 应用命令 ---------------- */

/*
 * 命令索引接口 /guilds/{id}/application-command-index 已确认存在，但限流很紧
 * （Discord 自己打开「应用」菜单时也会请求它）。所以：
 *   1. 找到的命令对象持久化到 DataStore，下次直接用，基本不再请求；
 *   2. 请求时遇到 429 按 retry_after 等待后重试；
 *   3. 命令过期（bot 重新同步过命令）时由调用方 invalidateCommand 后重查。
 */
const STORE_KEY = "QuickSendoff_commands";
let memCache: Record<string, any> | null = null;
let inflight: Promise<any[]> | null = null;

const cmdKey = (guildId: string, appId: string, name: string, type: number) => `${guildId}:${appId}:${name}:${type}`;

async function loadCache() {
    if (!memCache) memCache = (await DataStore.get(STORE_KEY)) ?? {};
    return memCache!;
}

export async function clearCommandCache() {
    memCache = {};
    await DataStore.set(STORE_KEY, {});
}

export async function invalidateCommand(guildId: string, appId: string, name: string, type: 1 | 3) {
    const cache = await loadCache();
    delete cache[cmdKey(guildId, appId, name, type)];
    await DataStore.set(STORE_KEY, cache);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 把 RestAPI 抛出的各种错误整理成可读文字 */
export function describeError(e: any): string {
    if (e?.status === 429) return `请求太频繁，被 Discord 限流（${e.body?.retry_after ?? "?"} 秒）`;
    if (e?.body?.message) return `${e.status ?? ""} ${e.body.message}`.trim();
    return e?.message ?? String(e);
}

async function fetchIndex(guildId: string): Promise<any[]> {
    for (let attempt = 0; ; attempt++) {
        try {
            const res = await RestAPI.get({ url: `/guilds/${guildId}/application-command-index` });
            return (res.body as any)?.application_commands ?? [];
        } catch (e: any) {
            if (e?.status !== 429 || attempt >= 3) throw e;
            const wait = (Number(e.body?.retry_after ?? e.retryAfter ?? 1) + 0.3) * 1000;
            logger.warn(`命令索引被限流，${Math.round(wait)}ms 后重试`);
            await sleep(wait);
        }
    }
}

/** 找某个 bot 的命令：type 1 = 斜杠命令，type 3 = 消息右键命令 */
export async function findCommand(guildId: string, applicationId: string, name: string, type: 1 | 3) {
    const cache = await loadCache();
    const key = cmdKey(guildId, applicationId, name, type);
    if (cache[key]) return cache[key];

    // 同时有多个查找时共用一次请求
    inflight ??= fetchIndex(guildId).finally(() => { inflight = null; });
    const cmds = await inflight;
    const cmd = cmds.find(c => c.application_id === applicationId && c.name === name && c.type === type);
    if (!cmd) throw new Error(`找不到命令「${name}」，检查应用 ID 或你是否有权限看到它`);

    cache[key] = cmd;
    await DataStore.set(STORE_KEY, cache);
    return cmd;
}

export const findMessageCommand = (guildId: string, applicationId: string, name: string) =>
    findCommand(guildId, applicationId, name, 3);

/* ---------------- 发送交互 ---------------- */

export function newNonce(): string {
    return SnowflakeUtils.fromTimestamp(Date.now());
}

async function postInteraction(body: Record<string, any>, nonce: string) {
    // 抓包确认：请求体就是这个 JSON 结构
    await RestAPI.post({
        url: "/interactions",
        body: { ...body, nonce, session_id: AuthenticationStore.getSessionId() }
    });
}

/** 触发消息右键命令。nonce 由调用方先生成，便于在发送前就开始监听弹窗。 */
export async function runMessageCommand(ctx: Ctx, cmd: any, targetMessageId: string, nonce: string) {
    await postInteraction({
        type: 2,
        application_id: cmd.application_id,
        guild_id: ctx.guildId,
        channel_id: ctx.channelId,
        data: {
            version: cmd.version,
            id: cmd.id,
            // 服务器级命令要带 guild_id（抓包确认）
            ...(cmd.guild_id ? { guild_id: cmd.guild_id } : {}),
            name: cmd.name,
            type: 3,
            options: [],
            application_command: cmd,
            target_id: targetMessageId,
            attachments: []
        },
        analytics_location: "slash_ui"
    }, nonce);
}

/** 触发斜杠命令。options 按 Discord 格式传（子命令就是 type 1 套一层） */
export async function runSlashCommand(ctx: Ctx, cmd: any, options: any[], nonce: string) {
    await postInteraction({
        type: 2,
        application_id: cmd.application_id,
        guild_id: ctx.guildId,
        channel_id: ctx.channelId,
        data: {
            version: cmd.version,
            id: cmd.id,
            ...(cmd.guild_id ? { guild_id: cmd.guild_id } : {}),
            name: cmd.name,
            type: 1,
            options,
            application_command: cmd,
            attachments: []
        },
        analytics_location: "slash_ui"
    }, nonce);
}

/** 点击消息上的按钮 / 选择下拉菜单（gacha 流程要用） */
export async function clickComponent(
    ctx: Ctx,
    message: any,
    customId: string,
    componentType: number,
    values?: string[]
) {
    await postInteraction({
        type: 3,
        application_id: message.application_id ?? message.author?.id,
        guild_id: ctx.guildId,
        channel_id: ctx.channelId,
        message_id: message.id,
        message_flags: message.flags ?? 0,
        data: values
            ? { component_type: componentType, custom_id: customId, type: componentType, values }
            : { component_type: componentType, custom_id: customId }
    }, newNonce());
}

/* ---------------- 弹窗 ---------------- */

export interface ModalField {
    kind: "text" | "select";
    label: string;
    customId: string;
    options: { label: string; value: string; }[];
    wrapper: "label" | "row";
    wrapperId?: number;
}

export interface ModalInfo {
    id: string;
    customId: string;
    applicationId: string;
    nonce?: string;
    title: string;
    fields: ModalField[];
    raw: any;
}

const pick = (o: any, ...keys: string[]) => {
    for (const k of keys) if (o?.[k] != null) return o[k];
    return undefined;
};

/** 把 INTERACTION_MODAL_CREATE 事件整理成统一结构。[待核对] 字段名蛇形/驼峰都兼容一下 */
export function parseModal(e: any): ModalInfo {
    const fields: ModalField[] = [];
    const toField = (inner: any, label: string, wrapper: ModalField["wrapper"], wrapperId?: number) => {
        if (inner?.type === 4 || inner?.type === 3) {
            fields.push({
                kind: inner.type === 4 ? "text" : "select",
                label: label ?? inner.label ?? "",
                customId: pick(inner, "custom_id", "customId"),
                options: (inner.options ?? []).map((o: any) => ({ label: o.label, value: o.value })),
                wrapper,
                wrapperId
            });
        }
    };

    for (const c of e.components ?? []) {
        if (c.type === 18) toField(c.component, pick(c, "label", "text"), "label", c.id); // 新版 Label 组件
        else if (c.type === 1) for (const inner of c.components ?? []) toField(inner, inner.label, "row");
    }

    return {
        id: e.id,
        customId: pick(e, "custom_id", "customId"),
        applicationId: pick(e, "application_id", "applicationId") ?? e.application?.id,
        nonce: e.nonce,
        title: e.title,
        fields,
        raw: e
    };
}

export function findField(modal: ModalInfo, labelIncludes: string) {
    const f = modal.fields.find(f => f.label.includes(labelIncludes));
    if (!f) throw new Error(`弹窗里找不到「${labelIncludes}」字段，bot 可能改了弹窗`);
    return f;
}

/** 提交弹窗。values 以字段 customId 为键；文本框给字符串，下拉框给字符串数组。 */
export async function submitModal(ctx: Ctx, modal: ModalInfo, values: Record<string, string | string[]>) {
    const components = modal.fields.map(f => {
        const v = values[f.customId];
        const inner = f.kind === "text"
            ? { type: 4, custom_id: f.customId, value: (v as string) ?? "" }
            : { type: 3, custom_id: f.customId, values: (v as string[]) ?? [] };
        // 已按抓包确认：{ type: 18, component: {...} }，不带 id
        // 客户端弹窗事件里的 id 是 "0" / "0,0" 这种内部路径，不是真实组件 id，所以这里先不带 id
        return f.wrapper === "label"
            ? { type: 18, component: inner }
            : { type: 1, components: [inner] };
    });

    await postInteraction({
        type: 5,
        application_id: modal.applicationId,
        guild_id: ctx.guildId,
        channel_id: ctx.channelId,
        data: { id: modal.id, custom_id: modal.customId, components }
    }, newNonce());
}

/* ---------------- 等待事件 ---------------- */

/**
 * 监听一个或多个 Flux 事件，直到 match 返回非 undefined 的值或超时。
 * 一定要在发送交互「之前」调用，否则可能错过事件。
 */
export function waitForDispatch<T>(
    types: string[],
    match: (type: string, e: any) => T | undefined,
    timeoutMs: number,
    what: string
): Promise<T> {
    return new Promise((resolve, reject) => {
        const handlers = types.map(type => {
            const h = (e: any) => {
                let r: T | undefined;
                try {
                    r = match(type, e);
                } catch (err) {
                    logger.error("match 出错", err);
                    return;
                }
                if (r === undefined) return;
                cleanup();
                resolve(r);
            };
            FluxDispatcher.subscribe(type as any, h);
            return [type, h] as const;
        });
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`等待${what}超时`));
        }, timeoutMs);
        function cleanup() {
            clearTimeout(timer);
            for (const [type, h] of handlers) FluxDispatcher.unsubscribe(type as any, h);
        }
    });
}

/** 递归收集消息里的按钮(2)/下拉菜单(3)，gacha 流程用来找"选择小作文""确认"按钮 */
export function collectComponents(message: any): any[] {
    const out: any[] = [];
    const walk = (list: any[]) => {
        for (const c of list ?? []) {
            if (c.type === 2 || c.type === 3) out.push(c);
            if (c.components) walk(c.components);
            if (c.component) walk([c.component]);
            if (c.accessory) walk([c.accessory]);
        }
    };
    walk(message.components);
    return out;
}

/**
 * 关闭 bot 弹出来的弹窗。
 * 你那版 Discord 上 closeAllModals 会报错（reading 'has'），所以失败时改为模拟按 Esc。
 * 这一步出错绝不能影响主流程：提交早已发出，结果照常等待。
 */
export function closeBotModal() {
    setTimeout(() => {
        try {
            closeAllModals();
            return;
        } catch (e) {
            logger.warn("closeAllModals 失败，改用 Esc 关闭", e);
        }
        try {
            const opts = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
            const target = document.querySelector("[role=dialog]") ?? document.body;
            target.dispatchEvent(new KeyboardEvent("keydown", opts));
            target.dispatchEvent(new KeyboardEvent("keyup", opts));
        } catch (e) {
            logger.warn("Esc 关闭弹窗也失败了", e);
        }
    }, 50);
}
