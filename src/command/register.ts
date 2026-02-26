/**
 * 命令注册与执行链路
 * 注册 meme 相关命令并完成生成请求调用
 */

import { h, type Context, type Session } from "koishi";
import type { Config } from "../config";
import type { MemeInfoResponse } from "../types";
import { applyAutoFillPolicy } from "../domain/policy";
import { MemeBackendClient } from "../infra/client";
import { mapBackendStatus, mapNetworkError } from "../infra/errors";
import { parseCommandInput } from "./parse";
import {
  getBotAvatarImage,
  getMentionedSecondaryAvatarImage,
  getMentionedTargetAvatarImage,
  getMentionedTargetDisplayName,
  getSenderAvatarImage,
  getSenderDisplayName,
  resolveAvatarImageByUserId,
  resolveDisplayNameByUserId,
} from "../utils/avatar";
import {
  createShuffledKeys,
  getRandomCandidatesWithDedupe,
  pickRandomItem,
  recordRandomSelection,
} from "./random";
import {
  createMemeKeyResolver,
  listDirectAliases,
  shouldRegisterDirectAlias,
} from "./key-resolver";

interface HttpLikeError {
  response?: {
    status?: number;
    data?: {
      detail?: string;
    };
  };
  message?: string;
}

interface FrontendNotifier {
  update(payload: { type: "success"; content: string }): void;
}

interface PuppeteerLike {
  render(
    content: string,
    callback?: (
      page: {
        $: (selector: string) => Promise<unknown>;
        evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
      },
      next: (handle?: unknown) => Promise<string>,
    ) => Promise<string>,
  ): Promise<string>;
}

interface ContextWithOptionalServices extends Context {
  notifier?: {
    create(): FrontendNotifier;
  };
  puppeteer?: PuppeteerLike;
}

interface OneBotLikeInternalEvent {
  post_type?: unknown;
  notice_type?: unknown;
  sub_type?: unknown;
  target_id?: unknown;
  self_id?: unknown;
  user_id?: unknown;
  operator_id?: unknown;
  group_id?: unknown;
}

function asHttpError(error: unknown): HttpLikeError {
  if (typeof error !== "object" || error === null) {
    return { message: String(error) };
  }

  return error as HttpLikeError;
}

function mapRuntimeErrorMessage(error: unknown): string {
  const httpError = asHttpError(error);
  if (httpError.response?.status) {
    return mapBackendStatus(
      httpError.response.status,
      httpError.response.data?.detail,
    );
  }
  return mapNetworkError(error);
}

function buildRandomConfig(config: Config): Config {
  return {
    ...config,
    autoUseAvatarWhenMinImagesOneAndNoImage: true,
    autoFillOneMissingImageWithAvatar: true,
    autoFillSenderAndBotAvatarsWhenMinImagesTwoAndNoImage: true,
  };
}

type PreparedImages = Awaited<ReturnType<typeof parseCommandInput>>["images"];
type PreparedAvatarImage = Awaited<ReturnType<typeof getSenderAvatarImage>>;

interface MemeListInfoResult {
  key: string;
  info?: MemeInfoResponse;
}

type MemeListCategory =
  | "no-args"
  | "text-only"
  | "image-only"
  | "image-and-text"
  | "unknown";

interface MemeListEntry {
  alias: string;
  category: MemeListCategory;
}

interface ElementLike {
  type?: string;
  attrs?: {
    id?: unknown;
    name?: unknown;
    userId?: unknown;
    qq?: unknown;
  };
  children?: ElementLike[];
}

const MEME_LIST_CATEGORY_ORDER: MemeListCategory[] = [
  "no-args",
  "text-only",
  "image-only",
  "image-and-text",
  "unknown",
];

const MEME_LIST_CATEGORY_LABEL: Record<MemeListCategory, string> = {
  "no-args": "无需参数",
  "text-only": "仅需文字",
  "image-only": "仅需图片",
  "image-and-text": "图片+文字",
  unknown: "信息获取失败",
};

function normalizeMemeKey(value: string): string {
  return value.trim().toLowerCase();
}

function buildExcludedMemeKeySet(config: Config): Set<string> {
  return new Set(
    config.excludedMemeKeys
      .map((key) => normalizeMemeKey(key))
      .filter((key) => key.length > 0),
  );
}

function isExcludedMemeKey(key: string, excludedKeySet: Set<string>): boolean {
  return excludedKeySet.has(normalizeMemeKey(key));
}

function filterExcludedMemeKeys(
  keys: string[],
  excludedKeySet: Set<string>,
): string[] {
  return keys.filter((key) => !isExcludedMemeKey(key, excludedKeySet));
}

function resolveMemeListCategory(
  params: MemeInfoResponse["params_type"] | undefined,
): MemeListCategory {
  if (!params) return "unknown";

  const needImage = params.max_images > 0;
  const needText = params.max_texts > 0;

  if (!needImage && !needText) return "no-args";
  if (!needImage && needText) return "text-only";
  if (needImage && !needText) return "image-only";
  return "image-and-text";
}

function shouldExcludeByMemeCategory(
  category: MemeListCategory,
  config: Config,
): boolean {
  if (category === "text-only") return config.excludeTextOnlyMemes;
  if (category === "image-only") return config.excludeImageOnlyMemes;
  if (category === "image-and-text") return config.excludeImageAndTextMemes;
  return false;
}

function isParamsTypeExcludedByConfig(
  params: MemeInfoResponse["params_type"] | undefined,
  config: Config,
): boolean {
  return shouldExcludeByMemeCategory(resolveMemeListCategory(params), config);
}

async function buildCategoryExcludedMemeKeySet(
  client: MemeBackendClient,
  keys: string[],
  config: Config,
): Promise<Set<string>> {
  if (keys.length === 0) return new Set<string>();
  if (
    !config.excludeTextOnlyMemes &&
    !config.excludeImageOnlyMemes &&
    !config.excludeImageAndTextMemes
  ) {
    return new Set<string>();
  }

  const infoResults = await fetchMemeListInfos(client, keys, config);
  return new Set(
    infoResults
      .filter(
        (result) =>
          result.info &&
          isParamsTypeExcludedByConfig(result.info.params_type, config),
      )
      .map((result) => result.key),
  );
}

function pickChineseAlias(info: MemeInfoResponse): string {
  const aliases = [
    ...info.keywords,
    ...info.shortcuts.flatMap((shortcut) =>
      shortcut.humanized ? [shortcut.humanized, shortcut.key] : [shortcut.key],
    ),
  ]
    .map((alias) => alias.trim())
    .filter(Boolean);

  const chineseAlias = aliases.find((alias) => /[^\x00-\x7F]/.test(alias));
  if (chineseAlias) return chineseAlias;
  return info.key;
}

function resolveMemeListInfoConcurrency(
  config: Config,
  keyCount: number,
): number {
  if (keyCount <= 0) return 0;
  if (!config.enableInfoFetchConcurrencyLimit) return keyCount;

  const normalized = Number.isFinite(config.infoFetchConcurrency)
    ? Math.floor(config.infoFetchConcurrency)
    : 10;

  return Math.min(keyCount, Math.max(1, normalized));
}

async function fetchMemeListInfos(
  client: MemeBackendClient,
  keys: string[],
  config: Config,
): Promise<MemeListInfoResult[]> {
  const results: MemeListInfoResult[] = new Array(keys.length);
  const workerCount = resolveMemeListInfoConcurrency(config, keys.length);
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= keys.length) break;

      const key = keys[index];
      try {
        const info = await client.getInfo(key);
        results[index] = { key, info };
      } catch {
        results[index] = { key };
      }
    }
  });

  await Promise.all(workers);
  return results;
}

function buildMemeListEntries(
  infoResults: MemeListInfoResult[],
): MemeListEntry[] {
  return infoResults.map((result) => {
    if (!result.info) {
      return {
        alias: result.key,
        category: "unknown",
      };
    }

    return {
      alias: pickChineseAlias(result.info),
      category: resolveMemeListCategory(result.info.params_type),
    };
  });
}

function buildMemeListSections(entries: MemeListEntry[]): MemeListSection[] {
  const sections: MemeListSection[] = [];

  for (const category of MEME_LIST_CATEGORY_ORDER) {
    const aliases = Array.from(
      new Set(
        entries
          .filter((entry) => entry.category === category)
          .map((entry) => entry.alias.trim())
          .filter(Boolean)
          .sort((left, right) =>
            left.localeCompare(right, "zh-Hans-CN", {
              sensitivity: "base",
            }),
          ),
      ),
    );

    if (aliases.length === 0) continue;

    sections.push({
      title: MEME_LIST_CATEGORY_LABEL[category],
      aliases,
    });
  }

  return sections;
}

function formatMemeListLines(sections: MemeListSection[]): string[] {
  const lines: string[] = [];

  for (const section of sections) {
    lines.push(section.title);
    lines.push(section.aliases.join(" "));
    lines.push("");
  }

  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines;
}

function collectMentionTokens(session: Session): string[] {
  const mentionTokens: string[] = [];

  const appendMentionToken = (value: unknown): void => {
    if (typeof value !== "string" && typeof value !== "number") return;
    const normalizedValue = String(value).trim();
    if (!normalizedValue) return;
    mentionTokens.push(`@${normalizedValue}`);
  };

  const walk = (elements: readonly ElementLike[]): void => {
    for (const element of elements) {
      if (element.type === "at") {
        appendMentionToken(element.attrs?.id);
        appendMentionToken(element.attrs?.name);
        appendMentionToken(element.attrs?.userId);
        appendMentionToken(element.attrs?.qq);
      }
      if (element.children?.length) walk(element.children);
    }
  };

  if (Array.isArray(session.elements)) {
    walk(session.elements as ElementLike[]);
  }

  return mentionTokens.sort((left, right) => right.length - left.length);
}

function removeFirstOccurrence(source: string, target: string): string {
  const index = source.indexOf(target);
  if (index < 0) return source;
  return `${source.slice(0, index)} ${source.slice(index + target.length)}`;
}

function normalizeDirectAliasRestText(
  rest: string,
  session: Session,
): string[] {
  let normalizedRest = rest
    .replace(/^\s+/, "")
    .replace(/<at\b[^>]*>(?:<\/at>)?/gi, " ");

  for (const mentionToken of collectMentionTokens(session)) {
    normalizedRest = removeFirstOccurrence(normalizedRest, mentionToken);
  }

  normalizedRest = normalizedRest.trim();
  if (!normalizedRest) return [];

  return normalizedRest
    .split(/\s+/)
    .map((text) => text.trim())
    .filter(Boolean);
}

function extractDirectAliasTexts(
  session: Session,
  alias: string,
  allowMergedSuffix: boolean,
): string[] | undefined {
  const strippedContent = session.stripped?.content;
  if (typeof strippedContent !== "string") return undefined;

  const content = strippedContent.trim();
  if (!content.startsWith(alias)) return undefined;

  const rest = content.slice(alias.length);
  if (!rest) return [];
  if (!allowMergedSuffix && !/^\s/.test(rest)) return undefined;

  return normalizeDirectAliasRestText(rest, session);
}

function escapeRegExp(source: string): string {
  return source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createStrictDirectAliasPattern(alias: string): RegExp {
  return new RegExp(`^${escapeRegExp(alias)}(?:\\s+[\\s\\S]*)?$`);
}

function createMergedDirectAliasPattern(alias: string): RegExp {
  return new RegExp(`^${escapeRegExp(alias)}[\\s\\S]*$`);
}

function resolveFirstDirectAlias(
  keywords: string[],
  shortcuts: Array<{ key: string; humanized?: string }>,
): string | undefined {
  const aliases = [
    ...keywords,
    ...shortcuts.flatMap((shortcut) =>
      shortcut.humanized ? [shortcut.key, shortcut.humanized] : [shortcut.key],
    ),
  ]
    .map((alias) => alias.trim())
    .filter(Boolean)
    .filter((alias) => shouldRegisterDirectAlias(alias));

  const preferredAlias = aliases.find(
    (alias) => /[^\x00-\x7F]/.test(alias) && alias.length >= 2,
  );
  return preferredAlias;
}

function isPokeTargetingCurrentBot(session: Session): boolean {
  const sessionLike = session as unknown as { onebot?: unknown };
  const onebotPayload = sessionLike.onebot;
  if (!onebotPayload || typeof onebotPayload !== "object") return false;

  const eventData = onebotPayload as OneBotLikeInternalEvent;
  const postType =
    typeof eventData.post_type === "string"
      ? eventData.post_type.toLowerCase()
      : "";
  const noticeType =
    typeof eventData.notice_type === "string"
      ? eventData.notice_type.toLowerCase()
      : "";
  const subType =
    typeof eventData.sub_type === "string"
      ? eventData.sub_type.toLowerCase()
      : "";

  if (
    !(postType === "notice" && noticeType === "notify" && subType === "poke")
  ) {
    return false;
  }

  const targetId =
    eventData.target_id == null ? "" : String(eventData.target_id).trim();
  const selfId =
    eventData.self_id == null
      ? (session.selfId ?? "")
      : String(eventData.self_id).trim();

  return targetId.length > 0 && selfId.length > 0 && targetId === selfId;
}

function isPokeTriggerSession(session: Session): boolean {
  if (isPokeTargetingCurrentBot(session)) return true;
  const type = session.type?.toLowerCase() || "";
  const subtype = session.subtype?.toLowerCase() || "";
  return type === "notice" && subtype === "poke";
}

function resolvePokeOperatorId(session: Session): string | undefined {
  const onebotPayload = (session as unknown as { onebot?: unknown }).onebot;
  if (!onebotPayload || typeof onebotPayload !== "object") return undefined;
  const eventData = onebotPayload as OneBotLikeInternalEvent;
  const rawOperator = eventData.operator_id ?? eventData.user_id;
  if (rawOperator == null) return undefined;
  const operatorId = String(rawOperator).trim();
  return operatorId || undefined;
}

function resolvePokeGuildId(session: Session): string | undefined {
  const onebotPayload = (session as unknown as { onebot?: unknown }).onebot;
  if (!onebotPayload || typeof onebotPayload !== "object")
    return session.guildId;
  const eventData = onebotPayload as OneBotLikeInternalEvent;
  const rawGuildId = eventData.group_id;
  if (rawGuildId == null) return session.guildId;
  const guildId = String(rawGuildId).trim();
  return guildId || session.guildId;
}

function normalizePokeDisplayName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized;
}

function isPureNumericId(value: string): boolean {
  return /^\d{5,}$/.test(value);
}

function resolvePokeRuntimeSenderFallback(
  session: Session,
): string | undefined {
  const onebotPayload = (session as unknown as { onebot?: unknown }).onebot;
  if (!onebotPayload || typeof onebotPayload !== "object") return undefined;

  const eventData = onebotPayload as Record<string, unknown>;
  const sender =
    (eventData.sender as Record<string, unknown> | undefined) ?? undefined;

  const card = normalizePokeDisplayName(sender?.card ?? eventData.card);
  if (card) return card;

  const nickname = normalizePokeDisplayName(
    sender?.nickname ?? eventData.nickname,
  );
  if (nickname) return nickname;

  const title = normalizePokeDisplayName(sender?.title ?? eventData.title);
  if (title) return title;

  return undefined;
}

function sanitizeResolvedPokeDisplayName(
  name: string | undefined,
  actorUserId?: string,
): string | undefined {
  const normalizedName = normalizePokeDisplayName(name);
  if (!normalizedName) return undefined;
  if (actorUserId && normalizedName === actorUserId) return undefined;
  if (isPureNumericId(normalizedName) && !actorUserId) return undefined;
  if (isPureNumericId(normalizedName) && normalizedName === actorUserId) {
    return undefined;
  }
  return normalizedName;
}

async function resolvePokeRuntimeHints(session: Session): Promise<{
  senderName?: string;
  groupNicknameText?: string;
  actorUserId?: string;
  preferredGuildId?: string;
}> {
  const senderFallbackName = resolvePokeRuntimeSenderFallback(session);
  const senderName = senderFallbackName || getSenderDisplayName(session);
  if (!isPokeTriggerSession(session)) {
    return { senderName };
  }

  const operatorId = resolvePokeOperatorId(session);
  const fallbackUserId = session.userId?.trim();
  const actorUserId = operatorId || fallbackUserId;
  if (!actorUserId) {
    return { senderName };
  }

  const resolvedGuildId = resolvePokeGuildId(session);
  const preferredGuildId =
    resolvedGuildId && resolvedGuildId !== "private"
      ? resolvedGuildId
      : undefined;

  const operatorDisplayName = sanitizeResolvedPokeDisplayName(
    await resolveDisplayNameByUserId(session, actorUserId, preferredGuildId),
    actorUserId,
  );

  return {
    senderName: operatorDisplayName || senderName,
    groupNicknameText: operatorDisplayName || senderFallbackName || senderName,
    actorUserId,
    preferredGuildId,
  };
}

async function resolvePokeAvatarHints(
  ctx: Context,
  session: Session,
  timeoutMs: number,
): Promise<{
  senderAvatarImage?: PreparedAvatarImage;
  targetAvatarImage?: PreparedAvatarImage;
  secondaryTargetAvatarImage?: PreparedAvatarImage;
  botAvatarImage?: PreparedAvatarImage;
}> {
  const pokeRuntimeHints = await resolvePokeRuntimeHints(session);
  const senderAvatarImage = await getSenderAvatarImage(ctx, session, timeoutMs);
  const targetAvatarImage = await getMentionedTargetAvatarImage(
    ctx,
    session,
    timeoutMs,
  );
  const secondaryTargetAvatarImage = await getMentionedSecondaryAvatarImage(
    ctx,
    session,
    timeoutMs,
  );
  const botAvatarImage = await getBotAvatarImage(ctx, session, timeoutMs);

  if (!isPokeTriggerSession(session)) {
    return {
      senderAvatarImage,
      targetAvatarImage,
      secondaryTargetAvatarImage,
      botAvatarImage,
    };
  }

  const actorUserId = pokeRuntimeHints.actorUserId;
  const preferredGuildId = pokeRuntimeHints.preferredGuildId;

  const actorAvatarImage = actorUserId
    ? await resolveAvatarImageByUserId(
        ctx,
        session,
        actorUserId,
        timeoutMs,
        preferredGuildId,
        "poke-actor-avatar",
      )
    : undefined;

  return {
    senderAvatarImage: senderAvatarImage || actorAvatarImage,
    targetAvatarImage: targetAvatarImage || actorAvatarImage,
    secondaryTargetAvatarImage,
    botAvatarImage,
  };
}

function resolvePokeCooldownScopeKey(session: Session): string {
  const channelId = session.channelId?.trim();
  if (channelId) return `channel:${channelId}`;

  const guildId = session.guildId?.trim();
  if (guildId) return `guild:${guildId}`;

  const operatorId = resolvePokeOperatorId(session);
  if (operatorId) return `user:${operatorId}`;

  const userId = session.userId?.trim();
  if (userId) return `user:${userId}`;

  return "global";
}

function replyOrSilent(
  config: Config,
  logger: ReturnType<Context["logger"]>,
  scope: string,
  message: string,
): string {
  if (config.disableErrorReplyToPlatform) {
    logger.warn("%s skipped reply: %s", scope, message);
    return "";
  }
  return message;
}

function toBase64(data: unknown): string | undefined {
  if (Buffer.isBuffer(data)) return data.toString("base64");
  if (data instanceof Uint8Array) return Buffer.from(data).toString("base64");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("base64");
  return undefined;
}

function stringifyImageSegment(image: ReturnType<typeof h.image>): string {
  const normalize = (h as { normalize?: (value: unknown) => unknown[] })
    .normalize;
  if (typeof normalize === "function") {
    const normalized = normalize(image)
      .map((value) => String(value))
      .join("");
    if (normalized.trim()) return normalized;
  }

  const text = String(image);
  if (text && text !== "[object Object]") return text;

  const imageLike = image as unknown as {
    attrs?: { src?: unknown; url?: unknown };
    mimeType?: unknown;
    buffer?: unknown;
  };

  const source = imageLike.attrs?.src ?? imageLike.attrs?.url;
  if (typeof source === "string" && source.trim()) {
    return `<img src="${source.trim()}"/>`;
  }

  const base64 = toBase64(imageLike.buffer);
  if (!base64) return "<img/>";

  const mimeType =
    typeof imageLike.mimeType === "string" && imageLike.mimeType.trim()
      ? imageLike.mimeType.trim()
      : "image/png";

  return `<img src="data:${mimeType};base64,${base64}"/>`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

interface MemeListSection {
  title: string;
  aliases: string[];
}

async function buildListMessage(
  ctx: ContextWithOptionalServices,
  sections: MemeListSection[],
  lines: string[],
  renderAsImage: boolean,
  _platform: string | undefined,
  logger: ReturnType<Context["logger"]>,
): Promise<string> {
  const content = lines.join("\n");
  if (!renderAsImage || !ctx.puppeteer) return content;

  const width = 2400;
  const titleFontSize = 22;
  const aliasFontSize = 16;
  const paddingX = 72;
  const paddingY = 72;

  try {
    const sectionContent = sections
      .map((section) => {
        const aliasCells = section.aliases
          .map((alias) => `<div class="alias-cell">${escapeXml(alias)}</div>`)
          .join("");
        return `<section class="section"><div class="section-title">${escapeXml(section.title)}</div><div class="alias-grid">${aliasCells}</div></section>`;
      })
      .join("");

    const fallbackContent = lines
      .map((line) => `<div class="line">${escapeXml(line)}</div>`)
      .join("");

    const html = `<!doctype html><html><head><meta charset="utf-8"/><style>body{margin:0;padding:0;background:#f5f7fb;}#list{width:${width}px;padding:${paddingY}px ${paddingX}px;box-sizing:border-box;color:#0f172a;font-family:"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Noto Emoji","Segoe UI Symbol","PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Arial Unicode MS",sans-serif;font-variant-emoji:emoji;text-rendering:optimizeLegibility;-webkit-font-smoothing:antialiased;}.section{margin:0 0 22px 0;border:1px solid #cbd5e1;border-radius:10px;overflow:hidden;background:#ffffff;}.section-title{padding:12px 16px;background:#e2e8f0;border-bottom:1px solid #cbd5e1;font-size:${titleFontSize}px;line-height:1.4;font-weight:700;}.alias-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));}.alias-cell{padding:10px 12px;font-size:${aliasFontSize}px;line-height:1.5;border-right:1px solid #dbe3ee;border-bottom:1px solid #dbe3ee;word-break:break-word;overflow-wrap:anywhere;background:#ffffff;}.alias-cell:nth-child(2n){background:#f8fafc;}.line{font-size:${aliasFontSize}px;line-height:1.6;white-space:pre-wrap;word-break:break-word;overflow-wrap:anywhere;}.alias-cell img.emoji,.line img.emoji{width:1.15em;height:1.15em;vertical-align:-0.2em;margin:0 0.02em;}</style></head><body><div id="list">${sections.length > 0 ? sectionContent : fallbackContent}</div></body></html>`;

    const renderedSegment = await ctx.puppeteer.render(
      html,
      async (page, next) => {
        await page.evaluate(async () => {
          const loadTwemoji = async (): Promise<boolean> => {
            const twemojiApi = (window as unknown as { twemoji?: unknown })
              .twemoji;
            if (twemojiApi) return true;

            const scriptUrls = [
              "https://cdn.jsdelivr.net/npm/twemoji@14.0.2/dist/twemoji.min.js",
              "https://unpkg.com/twemoji@14.0.2/dist/twemoji.min.js",
            ];

            const loadScript = async (url: string): Promise<boolean> => {
              return await new Promise<boolean>((resolve) => {
                const script = document.createElement("script");
                script.src = url;
                script.async = true;
                script.onload = () => resolve(true);
                script.onerror = () => resolve(false);
                document.head.appendChild(script);
              });
            };

            for (const url of scriptUrls) {
              const loaded = await loadScript(url);
              if (loaded) return true;
            }

            return false;
          };

          if (typeof document !== "undefined" && document.fonts?.ready) {
            await document.fonts.ready;
          }

          const loaded = await loadTwemoji();
          if (!loaded) return;

          const listNode = document.querySelector("#list");
          const twemojiApi = (
            window as unknown as {
              twemoji?: {
                parse: (
                  node: Element,
                  options?: {
                    base?: string;
                    folder?: string;
                    ext?: string;
                    className?: string;
                  },
                ) => void;
              };
            }
          ).twemoji;
          if (!listNode || !twemojiApi) return;

          twemojiApi.parse(listNode, {
            base: "https://cdn.jsdelivr.net/gh/twitter/twemoji@14.0.2/assets/",
            folder: "svg",
            ext: ".svg",
            className: "emoji",
          });

          const emojiImages = Array.from(
            document.querySelectorAll<HTMLImageElement>("#list img.emoji"),
          );
          if (emojiImages.length === 0) return;

          await Promise.race([
            Promise.all(
              emojiImages.map(
                (image) =>
                  new Promise<void>((resolve) => {
                    if (image.complete) {
                      resolve();
                      return;
                    }
                    image.addEventListener("load", () => resolve(), {
                      once: true,
                    });
                    image.addEventListener("error", () => resolve(), {
                      once: true,
                    });
                  }),
              ),
            ),
            new Promise<void>((resolve) => setTimeout(resolve, 2500)),
          ]);
        });

        const handle = await page.$("#list");
        return next(handle);
      },
    );

    return renderedSegment || content;
  } catch (error) {
    logger.warn(
      "meme.list image render failed, fallback to text: %s",
      String(error),
    );
    return content;
  }
}

export function registerCommands(ctx: Context, config: Config): void {
  const client = new MemeBackendClient(
    ctx,
    config.baseUrl.replace(/\/$/, ""),
    config.timeoutMs,
  );
  const excludedMemeKeySet = buildExcludedMemeKeySet(config);
  let categoryExcludedMemeKeySet = new Set<string>();
  let categoryExcludedMemeKeySetLoaded = false;
  const ensureCategoryExcludedMemeKeySet = async (
    rawKeys?: string[],
    forceRefresh = false,
  ): Promise<void> => {
    if (categoryExcludedMemeKeySetLoaded && !forceRefresh) return;
    const keys = rawKeys ?? (await client.getKeys());
    categoryExcludedMemeKeySet = await buildCategoryExcludedMemeKeySet(
      client,
      keys,
      config,
    );
    categoryExcludedMemeKeySetLoaded = true;
  };
  const mergedExcludedMemeKeySet = (): Set<string> => {
    if (categoryExcludedMemeKeySet.size === 0) return excludedMemeKeySet;
    return new Set([...excludedMemeKeySet, ...categoryExcludedMemeKeySet]);
  };

  const resolveMemeKey = createMemeKeyResolver(client, {
    enableInfoFetchConcurrencyLimit: config.enableInfoFetchConcurrencyLimit,
    infoFetchConcurrency: config.infoFetchConcurrency,
  });
  const logger = ctx.logger("chatluna-meme-generator");

  const handleErrorReply = (scope: string, message: string): string => {
    if (!config.disableErrorReplyToPlatform) return message;
    logger.warn("%s failed: %s", scope, message);
    return "";
  };

  const handleRuntimeError = (scope: string, error: unknown): string => {
    return handleErrorReply(scope, mapRuntimeErrorMessage(error));
  };

  const executePreview = async (
    key: string,
  ): Promise<string | ReturnType<typeof h.image>> => {
    if (!key) return handleErrorReply("meme.preview", "请提供模板 key。");

    try {
      await ensureCategoryExcludedMemeKeySet();
      const resolvedKey = await resolveMemeKey(key);
      if (isExcludedMemeKey(resolvedKey, mergedExcludedMemeKeySet())) {
        return handleErrorReply("meme.preview", "该模板已被排除。");
      }
      const preview = await client.getPreview(resolvedKey);
      return h.image(Buffer.from(preview.buffer), preview.mimeType);
    } catch (error) {
      return handleRuntimeError("meme.preview", error);
    }
  };

  ctx.command("meme.list", "列出可用 meme 模板").action(async ({ session }) => {
    try {
      const oldMergedExcludedCount = mergedExcludedMemeKeySet().size;
      const rawKeys = await client.getKeys();
      await ensureCategoryExcludedMemeKeySet(rawKeys, true);
      const keys = filterExcludedMemeKeys(rawKeys, mergedExcludedMemeKeySet());
      if (oldMergedExcludedCount !== mergedExcludedMemeKeySet().size) {
        logger.info(
          "meme category exclusion loaded: %d keys",
          categoryExcludedMemeKeySet.size,
        );
      }
      if (keys.length === 0)
        return replyOrSilent(
          config,
          logger,
          "meme.list",
          "当前后端没有可用模板。",
        );

      const infoResults = await fetchMemeListInfos(client, keys, config);
      const entries = buildMemeListEntries(infoResults);
      const sections = buildMemeListSections(entries);
      const lines = formatMemeListLines(sections);
      if (lines.length === 0)
        return replyOrSilent(
          config,
          logger,
          "meme.list",
          "当前后端没有可用模板。",
        );

      return await buildListMessage(
        ctx as ContextWithOptionalServices,
        sections,
        lines,
        config.renderMemeListAsImage,
        (session as { platform?: string } | undefined)?.platform,
        logger,
      );
    } catch (error) {
      return handleRuntimeError("meme.list", error);
    }
  });

  ctx
    .command("meme.info <key:string>", "查看模板参数约束")
    .action(async (_, key) => {
      if (!key) return handleErrorReply("meme.info", "请提供模板 key。");
      try {
        await ensureCategoryExcludedMemeKeySet();
        const resolvedKey = await resolveMemeKey(key);
        if (isExcludedMemeKey(resolvedKey, mergedExcludedMemeKeySet())) {
          return handleErrorReply("meme.info", "该模板已被排除。");
        }
        const info = await client.getInfo(resolvedKey);
        const params = info.params_type;
        return [
          `key: ${info.key}`,
          `images: ${params.min_images} ~ ${params.max_images}`,
          `texts: ${params.min_texts} ~ ${params.max_texts}`,
          `default_texts: ${params.default_texts.join(" | ") || "(空)"}`,
        ].join("\n");
      } catch (error) {
        return handleRuntimeError("meme.info", error);
      }
    });

  ctx
    .command("meme.preview <key:string>", "预览模板效果")
    .action(async (_, key) => executePreview(key));

  const aliasLogger = logger;
  let initializedNotified = false;
  const notifier = (ctx as ContextWithOptionalServices).notifier?.create();

  const notifyInitializedSummary = (count: number): void => {
    if (initializedNotified) return;
    initializedNotified = true;
    notifier?.update({
      type: "success",
      content: `插件初始化完毕，共载入 ${count} 个表情。`,
    });
  };

  let randomSelectionHistory = new Map<string, number>();
  let randomSelectionQueue: Promise<void> = Promise.resolve();
  const pokeCooldownHistory = new Map<string, number>();

  const withRandomSelectionLock = async <T>(
    task: () => Promise<T>,
  ): Promise<T> => {
    const previous = randomSelectionQueue;
    let releaseLock: (() => void) | undefined;
    randomSelectionQueue = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    await previous;
    try {
      return await task();
    } finally {
      releaseLock?.();
    }
  };

  if (config.enableDirectAliasWithoutPrefix) {
    const directAliasMatchDisposers = new Map<string, () => void>();
    const registeredAliasKeySignatures = new Map<string, string>();
    const duplicatedAliasSignatures = new Map<string, string>();
    let aliasRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let aliasRetryAttempts = 0;
    let aliasRetryRunning = false;
    let aliasRetryDisposed = false;

    const maxAliasRetryAttempts = config.initLoadRetryTimes;

    const registerDirectAliases = async (): Promise<boolean> => {
      if (aliasRetryDisposed) return true;
      await ensureCategoryExcludedMemeKeySet();
      const result = await listDirectAliases(client, {
        enableInfoFetchConcurrencyLimit: config.enableInfoFetchConcurrencyLimit,
        infoFetchConcurrency: config.infoFetchConcurrency,
      });
      if (aliasRetryDisposed) return true;
      notifyInitializedSummary(result.totalKeys);
      let registeredCount = 0;
      let updatedCount = 0;
      let removedCount = 0;

      const filteredEntries = result.entries
        .map((entry) => ({
          ...entry,
          keys: entry.keys.filter(
            (key) => !isExcludedMemeKey(key, mergedExcludedMemeKeySet()),
          ),
        }))
        .filter((entry) => entry.keys.length > 0);

      const sortedEntries = [...filteredEntries].sort(
        (left, right) => right.alias.length - left.alias.length,
      );
      const activeAliases = new Set<string>();

      const duplicatedAliasEntries = sortedEntries.filter(
        (entry) => entry.keys.length > 1,
      );
      const duplicatedAliasSet = new Set(
        duplicatedAliasEntries.map((entry) => entry.alias),
      );
      for (const existingAlias of duplicatedAliasSignatures.keys()) {
        if (!duplicatedAliasSet.has(existingAlias)) {
          duplicatedAliasSignatures.delete(existingAlias);
        }
      }
      for (const duplicatedEntry of duplicatedAliasEntries) {
        const duplicatedSignature = duplicatedEntry.keys.join("\u0000");
        if (
          duplicatedAliasSignatures.get(duplicatedEntry.alias) ===
          duplicatedSignature
        ) {
          continue;
        }

        duplicatedAliasSignatures.set(
          duplicatedEntry.alias,
          duplicatedSignature,
        );
        aliasLogger.warn(
          "detected duplicate direct alias: %s -> %s",
          duplicatedEntry.alias,
          duplicatedEntry.keys.join(", "),
        );
      }

      for (const entry of sortedEntries) {
        if (!shouldRegisterDirectAlias(entry.alias)) continue;
        if (ctx.$commander.get(entry.alias)) continue;

        const aliasKeys = entry.keys.filter(Boolean);
        if (aliasKeys.length === 0) continue;
        activeAliases.add(entry.alias);

        const aliasKeySignature = aliasKeys.join("\u0000");
        const registeredSignature = registeredAliasKeySignatures.get(
          entry.alias,
        );
        if (registeredSignature === aliasKeySignature) continue;

        const previousDispose = directAliasMatchDisposers.get(entry.alias);
        if (previousDispose) {
          previousDispose();
          updatedCount += 1;
        } else {
          registeredCount += 1;
        }

        const directAliasPattern = config.allowMentionPrefixDirectAliasTrigger
          ? createMergedDirectAliasPattern(entry.alias)
          : createStrictDirectAliasPattern(entry.alias);

        const disposeMatch = ctx.$processor.match(
          directAliasPattern,
          async (session) => {
            const directAliasTexts = extractDirectAliasTexts(
              session,
              entry.alias,
              config.allowMentionPrefixDirectAliasTrigger,
            );
            if (!directAliasTexts) return "";

            const pickedKey =
              aliasKeys.length === 1
                ? aliasKeys[0]
                : aliasKeys[Math.floor(Math.random() * aliasKeys.length)];

            return (
              (await handleGenerate(
                ctx,
                session,
                client,
                config,
                pickedKey,
                directAliasTexts,
              )) ?? ""
            );
          },
          {
            appel: false,
            i18n: false,
            fuzzy: false,
          },
        );

        directAliasMatchDisposers.set(entry.alias, disposeMatch);
        registeredAliasKeySignatures.set(entry.alias, aliasKeySignature);
      }

      for (const [alias, disposeMatch] of directAliasMatchDisposers.entries()) {
        if (activeAliases.has(alias)) continue;
        disposeMatch();
        directAliasMatchDisposers.delete(alias);
        registeredAliasKeySignatures.delete(alias);
        duplicatedAliasSignatures.delete(alias);
        removedCount += 1;
      }

      aliasLogger.info(
        "registered direct aliases: %d (new: %d, updated: %d, removed: %d, duplicated aliases: %d, failed info keys: %d/%d)",
        directAliasMatchDisposers.size,
        registeredCount,
        updatedCount,
        removedCount,
        duplicatedAliasEntries.length,
        result.failedInfoKeys,
        result.totalKeys,
      );

      return !result.hasInfoFailure;
    };

    const clearAliasRetryTimer = (): void => {
      if (aliasRetryTimer) {
        clearTimeout(aliasRetryTimer);
        aliasRetryTimer = undefined;
      }
    };

    const stopAliasRetry = (): void => {
      clearAliasRetryTimer();
      aliasRetryRunning = false;
    };

    const scheduleAliasRetry = (delayMs: number): void => {
      if (aliasRetryDisposed) return;
      if (aliasRetryRunning && aliasRetryTimer) return;
      if (aliasRetryAttempts >= maxAliasRetryAttempts) {
        aliasLogger.warn(
          "direct alias retry stopped after %d attempts",
          aliasRetryAttempts,
        );
        stopAliasRetry();
        return;
      }

      aliasRetryRunning = true;
      aliasRetryTimer = setTimeout(() => {
        if (aliasRetryDisposed) {
          aliasRetryTimer = undefined;
          return;
        }
        aliasRetryTimer = undefined;
        aliasRetryAttempts += 1;

        void registerDirectAliases()
          .then((isComplete) => {
            if (aliasRetryDisposed) {
              stopAliasRetry();
              return;
            }
            if (isComplete) {
              aliasRetryAttempts = 0;
              stopAliasRetry();
              return;
            }

            aliasLogger.warn(
              "direct alias list still incomplete (attempt %d/%d), scheduling retry",
              aliasRetryAttempts,
              maxAliasRetryAttempts,
            );
            scheduleAliasRetry(3000);
          })
          .catch((retryError) => {
            if (aliasRetryDisposed) {
              stopAliasRetry();
              return;
            }
            aliasLogger.warn(
              "failed to register direct aliases on retry (attempt %d/%d): %s",
              aliasRetryAttempts,
              maxAliasRetryAttempts,
              String(retryError),
            );
            scheduleAliasRetry(3000);
          });
      }, delayMs);
    };

    ctx.on("ready", () => {
      aliasRetryDisposed = false;
      aliasRetryAttempts = 0;
      stopAliasRetry();

      void registerDirectAliases()
        .then((isComplete) => {
          if (!isComplete) {
            aliasLogger.warn(
              "direct alias list is incomplete at startup, scheduling retry",
            );
            scheduleAliasRetry(3000);
          }
        })
        .catch((error) => {
          aliasLogger.warn(
            "failed to register direct aliases at startup: %s",
            String(error),
          );
          scheduleAliasRetry(3000);
        });
    });

    ctx.on("dispose", () => {
      aliasRetryDisposed = true;
      stopAliasRetry();
      for (const disposeMatch of directAliasMatchDisposers.values()) {
        disposeMatch();
      }
      directAliasMatchDisposers.clear();
      registeredAliasKeySignatures.clear();
      duplicatedAliasSignatures.clear();
    });
  } else {
    let initRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let initRetryAttempts = 0;
    let initRetryDisposed = false;
    const maxInitRetryAttempts = config.initLoadRetryTimes;

    const clearInitRetryTimer = (): void => {
      if (initRetryTimer) {
        clearTimeout(initRetryTimer);
        initRetryTimer = undefined;
      }
    };

    const stopInitRetry = (): void => {
      clearInitRetryTimer();
    };

    const scheduleInitRetry = (delayMs: number): void => {
      if (initRetryDisposed) return;
      if (initRetryTimer) return;
      if (initRetryAttempts >= maxInitRetryAttempts) {
        aliasLogger.warn(
          "初始化时获取表情列表重试在 %d 次后停止",
          initRetryAttempts,
        );
        stopInitRetry();
        return;
      }

      initRetryTimer = setTimeout(() => {
        if (initRetryDisposed) {
          initRetryTimer = undefined;
          return;
        }
        initRetryTimer = undefined;
        initRetryAttempts += 1;

        void client
          .getKeys()
          .then((keys) => {
            if (initRetryDisposed) {
              stopInitRetry();
              return;
            }
            notifyInitializedSummary(keys.length);
            initRetryAttempts = 0;
            stopInitRetry();
          })
          .catch((retryError) => {
            if (initRetryDisposed) {
              stopInitRetry();
              return;
            }
            aliasLogger.warn(
              "初始化时获取表情列表失败（attempt %d/%d）: %s",
              initRetryAttempts,
              maxInitRetryAttempts,
              String(retryError),
            );
            scheduleInitRetry(3000);
          });
      }, delayMs);
    };

    ctx.on("ready", async () => {
      try {
        const rawKeys = await client.getKeys();
        await ensureCategoryExcludedMemeKeySet(rawKeys, true);
        const keyCount = filterExcludedMemeKeys(
          rawKeys,
          mergedExcludedMemeKeySet(),
        ).length;
        notifyInitializedSummary(keyCount);
      } catch (error) {
        aliasLogger.warn("初始化时获取表情列表失败: %s", String(error));
        scheduleInitRetry(3000);
      }
    });

    ctx.on("dispose", () => {
      initRetryDisposed = true;
      stopInitRetry();
    });
  }

  ctx
    .command("meme <key:string> [...texts]", "生成 meme 图片")
    .action(async ({ session }, key, ...texts) => {
      if (!session)
        return handleErrorReply("meme.generate", "当前上下文不可用。");
      if (!key) return handleErrorReply("meme.generate", "请提供模板 key。");

      try {
        await ensureCategoryExcludedMemeKeySet();
        const resolvedKey = await resolveMemeKey(key);
        if (isExcludedMemeKey(resolvedKey, mergedExcludedMemeKeySet())) {
          return handleErrorReply("meme.generate", "该模板已被排除。");
        }
        return await handleGenerate(
          ctx,
          session,
          client,
          config,
          resolvedKey,
          texts,
        );
      } catch (error) {
        return handleRuntimeError("meme.generate", error);
      }
    });

  const runRandomMeme = async (
    session: Session,
    texts: string[],
  ): Promise<string | ReturnType<typeof h.image>> => {
    try {
      await ensureCategoryExcludedMemeKeySet();
      const executeRandom = async () => {
        const shuffledKeys = createShuffledKeys(await client.getKeys());
        const filteredShuffledKeys = filterExcludedMemeKeys(
          shuffledKeys,
          mergedExcludedMemeKeySet(),
        );
        if (filteredShuffledKeys.length === 0) {
          return replyOrSilent(
            config,
            logger,
            "meme.random",
            "当前后端没有可用模板。",
          );
        }

        const parsedInput = await parseCommandInput(
          ctx,
          session,
          texts,
          config,
        );
        const pokeRuntimeHints = await resolvePokeRuntimeHints(session);
        const senderName =
          pokeRuntimeHints.senderName || getSenderDisplayName(session);
        const groupNicknameEnabled =
          config.autoUseGroupNicknameWhenNoDefaultText;
        const targetDisplayName = groupNicknameEnabled
          ? await getMentionedTargetDisplayName(session)
          : undefined;
        const groupNicknameText = groupNicknameEnabled
          ? targetDisplayName ||
            pokeRuntimeHints.groupNicknameText ||
            senderName
          : undefined;
        const {
          senderAvatarImage,
          targetAvatarImage,
          secondaryTargetAvatarImage,
          botAvatarImage,
        } = await resolvePokeAvatarHints(ctx, session, config.timeoutMs);
        const randomConfig = buildRandomConfig(config);
        const randomDedupeConfig = {
          enabled: config.enableRandomDedupeWithinHours,
          windowHours: config.randomDedupeWindowHours,
        };
        const eligibleCandidates: Array<{
          key: string;
          selectedTextSource?: "template-default" | "user-nickname";
          directAlias?: string;
        }> = [];
        let infoFailedCount = 0;

        for (const key of filteredShuffledKeys) {
          try {
            const info = await client.getInfo(key);
            const finalInput = applyAutoFillPolicy({
              texts: parsedInput.texts,
              images: parsedInput.images,
              params: info.params_type,
              config: randomConfig,
              senderAvatarImage,
              targetAvatarImage,
              secondaryTargetAvatarImage,
              botAvatarImage,
              senderName,
              groupNicknameText,
            });

            const imageCount = finalInput.images.length;
            const textCount = finalInput.texts.length;
            const imageMatch =
              imageCount >= info.params_type.min_images &&
              imageCount <= info.params_type.max_images;
            const textMatch =
              textCount >= info.params_type.min_texts &&
              textCount <= info.params_type.max_texts;
            if (imageMatch && textMatch) {
              eligibleCandidates.push({
                key,
                selectedTextSource:
                  finalInput.selectedTextSource === "group-nickname"
                    ? undefined
                    : finalInput.selectedTextSource,
                directAlias: resolveFirstDirectAlias(
                  info.keywords,
                  info.shortcuts,
                ),
              });
            }
          } catch (error) {
            infoFailedCount += 1;
            logger.warn("meme.random skip key %s: %s", key, String(error));
          }
        }

        const dedupeResult = getRandomCandidatesWithDedupe(
          eligibleCandidates,
          randomSelectionHistory,
          randomDedupeConfig,
        );

        let historyForRecord = dedupeResult.history;
        let candidatesForPick = dedupeResult.candidates;
        if (
          randomDedupeConfig.enabled &&
          eligibleCandidates.length > 0 &&
          candidatesForPick.length === 0
        ) {
          historyForRecord = new Map<string, number>();
          candidatesForPick = eligibleCandidates;
        }

        const randomCandidate = pickRandomItem(candidatesForPick);
        if (!randomCandidate) {
          if (infoFailedCount === filteredShuffledKeys.length) {
            return handleErrorReply(
              "meme.random",
              "随机筛选失败：后端不可用或超时，请稍后重试。",
            );
          }
          return replyOrSilent(
            config,
            logger,
            "meme.random",
            "未找到符合当前输入条件的随机模板，请补充图片或文字后重试。",
          );
        }

        try {
          logger.info("meme trigger key: %s", randomCandidate.key);
          const result = await handleGenerateWithPreparedInput(
            client,
            randomConfig,
            randomCandidate.key,
            parsedInput.texts,
            parsedInput.images,
            senderAvatarImage,
            targetAvatarImage,
            secondaryTargetAvatarImage,
            botAvatarImage,
            senderName,
            groupNicknameText,
            randomCandidate.selectedTextSource,
          );

          randomSelectionHistory = recordRandomSelection(
            historyForRecord,
            randomCandidate.key,
            randomDedupeConfig,
          );

          if (config.enableRandomKeywordNotice) {
            const randomTriggerText = randomCandidate.directAlias
              ? randomCandidate.directAlias
              : `meme ${randomCandidate.key}`;
            return `${randomTriggerText}\n${stringifyImageSegment(result)}`;
          }

          return result;
        } catch (error) {
          const runtimeMessage = mapRuntimeErrorMessage(error);
          if (config.disableErrorReplyToPlatform) {
            logger.warn("meme.random failed: %s", runtimeMessage);
            return "";
          }
          return [`random key: ${randomCandidate.key}`, runtimeMessage].join(
            "\n",
          );
        }
      };

      if (!config.enableRandomDedupeWithinHours) {
        return await executeRandom();
      }

      return await withRandomSelectionLock(executeRandom);
    } catch (error) {
      return handleRuntimeError("meme.random", error);
    }
  };

  ctx
    .command("meme.random [...texts]", "随机选择模板并生成 meme 图片")
    .action(async ({ session }, ...texts) => {
      if (!session)
        return handleErrorReply("meme.random", "当前上下文不可用。");
      return await runRandomMeme(session, texts);
    });

  if (config.enablePokeTriggerRandom) {
    ctx.on("internal/session", async (session) => {
      if (session.type !== "notice") return;
      if (!isPokeTriggerSession(session)) return;

      const cooldownSeconds = Math.max(
        0,
        config.pokeTriggerCooldownSeconds || 0,
      );
      if (cooldownSeconds > 0) {
        const scopeKey = resolvePokeCooldownScopeKey(session);
        const now = Date.now();
        const lastTriggerAt = pokeCooldownHistory.get(scopeKey) || 0;
        if (now - lastTriggerAt < cooldownSeconds * 1000) return;
        pokeCooldownHistory.set(scopeKey, now);
      }

      const randomResult = await runRandomMeme(session, []);
      if (!randomResult) return;
      await session.send(randomResult);
    });
  }
}

async function handleGenerate(
  ctx: Context,
  session: Session,
  client: MemeBackendClient,
  config: Config,
  key: string,
  texts: string[],
): Promise<string | ReturnType<typeof h.image>> {
  try {
    ctx.logger("chatluna-meme-generator").info("meme trigger key: %s", key);
    const parsedInput = await parseCommandInput(ctx, session, texts, config);
    const senderName = getSenderDisplayName(session);
    const groupNicknameEnabled = config.autoUseGroupNicknameWhenNoDefaultText;
    const targetDisplayName = groupNicknameEnabled
      ? await getMentionedTargetDisplayName(session)
      : undefined;
    const groupNicknameText = groupNicknameEnabled
      ? targetDisplayName || senderName
      : undefined;
    const senderAvatarImage = await getSenderAvatarImage(
      ctx,
      session,
      config.timeoutMs,
    );
    const targetAvatarImage = await getMentionedTargetAvatarImage(
      ctx,
      session,
      config.timeoutMs,
    );
    const secondaryTargetAvatarImage = await getMentionedSecondaryAvatarImage(
      ctx,
      session,
      config.timeoutMs,
    );
    const botAvatarImage = await getBotAvatarImage(
      ctx,
      session,
      config.timeoutMs,
    );
    return await handleGenerateWithPreparedInput(
      client,
      config,
      key,
      parsedInput.texts,
      parsedInput.images,
      senderAvatarImage,
      targetAvatarImage,
      secondaryTargetAvatarImage,
      botAvatarImage,
      senderName,
      groupNicknameText,
    );
  } catch (error) {
    const runtimeMessage = mapRuntimeErrorMessage(error);
    if (config.disableErrorReplyToPlatform) {
      ctx
        .logger("chatluna-meme-generator")
        .warn("meme.generate failed: %s", runtimeMessage);
      return "";
    }
    return runtimeMessage;
  }
}

async function handleGenerateWithPreparedInput(
  client: MemeBackendClient,
  config: Config,
  key: string,
  texts: string[],
  images: PreparedImages,
  senderAvatarImage?: PreparedAvatarImage,
  targetAvatarImage?: PreparedAvatarImage,
  secondaryTargetAvatarImage?: PreparedAvatarImage,
  botAvatarImage?: PreparedAvatarImage,
  senderName?: string,
  groupNicknameText?: string,
  preferredTextSource?: "template-default" | "user-nickname",
): Promise<ReturnType<typeof h.image>> {
  const info = await client.getInfo(key);
  const finalInput = applyAutoFillPolicy({
    texts,
    images,
    params: info.params_type,
    config,
    senderAvatarImage,
    targetAvatarImage,
    secondaryTargetAvatarImage,
    botAvatarImage,
    senderName,
    groupNicknameText,
    preferredTextSource,
  });

  const result = await client.generate(
    key,
    finalInput.images,
    finalInput.texts,
    {},
  );
  return h.image(Buffer.from(result.buffer), result.mimeType);
}
