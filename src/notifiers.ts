import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import YAML from "yaml";
import { getDb } from "./db";

const VALID_TRANSPORTS = new Set(["telegram", "slack", "discord", "webhook", "log"]);

const REQUIRED_CONFIG_KEYS: Record<string, string[]> = {
  telegram: ["bot_token"],
  slack: ["webhook_url"],
  discord: ["webhook_url"],
  webhook: ["url"],
  log: [],
};

export interface NotifierProfile {
  name: string;
  transport: "telegram" | "slack" | "discord" | "webhook" | "log";
  config: Record<string, string>;
}

export interface NotificationPayload {
  boardSlug: string;
  taskId: number;
  title: string;
  eventKind: string;
  eventPayload: Record<string, unknown> | null;
  text: string;
}

function defaultNotifiersPath(): string {
  return process.env.KDI_NOTIFIERS_PATH || join(homedir(), ".config/kdi/notifiers.yaml");
}

function defaultCursorsDir(): string {
  return process.env.KDI_NOTIFIER_CURSORS_PATH || join(homedir(), ".local/share/kdi/notifier-cursors");
}

export const BUILTIN_LOG_NOTIFIER: NotifierProfile = {
  name: "log",
  transport: "log",
  config: {},
};

const DEFAULT_NOTIFIERS: Record<string, Omit<NotifierProfile, "name">> = {
  telegram: {
    transport: "telegram",
    config: { bot_token: "${TELEGRAM_BOT_TOKEN}" },
  },
  slack: {
    transport: "slack",
    config: { webhook_url: "${SLACK_WEBHOOK_URL}" },
  },
  discord: {
    transport: "discord",
    config: { webhook_url: "${DISCORD_WEBHOOK_URL}" },
  },
  webhook: {
    transport: "webhook",
    config: { url: "${WEBHOOK_URL}", secret: "${WEBHOOK_SECRET}" },
  },
};

function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, varName) => process.env[varName] ?? "");
}

function validateNotifierProfile(profile: unknown, context: string): NotifierProfile {
  if (typeof profile !== "object" || profile === null) {
    throw new Error(`Notifier profile ${context} must be an object`);
  }

  const p = profile as Record<string, unknown>;

  if (typeof p.name !== "string" || p.name.trim() === "") {
    throw new Error(`Notifier profile ${context} is missing required field "name"`);
  }

  if (typeof p.transport !== "string" || !VALID_TRANSPORTS.has(p.transport)) {
    throw new Error(`Notifier profile "${p.name}" has unknown transport "${p.transport}". Valid transports: ${Array.from(VALID_TRANSPORTS).join(", ")}`);
  }

  if (typeof p.config !== "object" || p.config === null || Array.isArray(p.config)) {
    throw new Error(`Notifier profile "${p.name}" field "config" must be an object`);
  }

  const config = p.config as Record<string, unknown>;
  const resolvedConfig: Record<string, string> = {};
  for (const [key, value] of Object.entries(config)) {
    if (typeof value !== "string") {
      throw new Error(`Notifier profile "${p.name}" config value for "${key}" must be a string`);
    }
    resolvedConfig[key] = resolveEnvVars(value);
  }

  return {
    name: p.name,
    transport: p.transport as NotifierProfile["transport"],
    config: resolvedConfig,
  };
}

export function ensureNotifiers(path: string = defaultNotifiersPath()): void {
  if (existsSync(path)) {
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  const doc = { notifiers: DEFAULT_NOTIFIERS };
  writeFileSync(path, YAML.stringify(doc), "utf-8");
}

export function loadNotifiers(path: string = defaultNotifiersPath()): NotifierProfile[] {
  if (!existsSync(path)) {
    return [BUILTIN_LOG_NOTIFIER];
  }

  const content = readFileSync(path, "utf-8");
  const parsed = YAML.parse(content);

  if (parsed === null || parsed === undefined) {
    return [BUILTIN_LOG_NOTIFIER];
  }

  let rawProfiles: unknown[] = [];

  if (Array.isArray(parsed)) {
    rawProfiles = parsed;
  } else if (typeof parsed === "object" && parsed !== null && "notifiers" in parsed) {
    const notifiers = (parsed as Record<string, unknown>).notifiers;
    if (Array.isArray(notifiers)) {
      rawProfiles = notifiers;
    } else if (typeof notifiers === "object" && notifiers !== null) {
      rawProfiles = Object.entries(notifiers).map(([name, value]) => {
        if (typeof value === "object" && value !== null) {
          return { name, ...(value as Record<string, unknown>) };
        }
        return { name };
      });
    }
  }

  const custom: NotifierProfile[] = [];
  for (let i = 0; i < rawProfiles.length; i++) {
    custom.push(validateNotifierProfile(rawProfiles[i], `at index ${i}`));
  }

  const customNames = new Set(custom.map((p) => p.name));
  const builtins = customNames.has(BUILTIN_LOG_NOTIFIER.name) ? [] : [BUILTIN_LOG_NOTIFIER];
  return [...builtins, ...custom];
}

export function getNotifier(name: string, path?: string): NotifierProfile {
  const profiles = loadNotifiers(path);
  const profile = profiles.find((p) => p.name === name);
  if (!profile) {
    throw new Error(`Notifier profile '${name}' not found.`);
  }

  if (profile.transport !== "log") {
    const required = REQUIRED_CONFIG_KEYS[profile.transport];
    for (const key of required) {
      if (!profile.config[key] || profile.config[key].trim() === "") {
        throw new Error(`Notifier profile '${name}' is missing required config key '${key}'.`);
      }
    }
  }

  return profile;
}

function cursorPath(boardSlug: string): string {
  return join(defaultCursorsDir(), `${boardSlug}.json`);
}

export function getLastSeenEventId(boardSlug: string): number {
  try {
    const raw = readFileSync(cursorPath(boardSlug), "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed.last_seen_event_id === "number") {
      return parsed.last_seen_event_id;
    }
  } catch {
    // Missing or corrupt cursor defaults to 0
  }
  return 0;
}

export function setLastSeenEventId(boardSlug: string, id: number): void {
  const path = cursorPath(boardSlug);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ last_seen_event_id: id, updated_at: Math.floor(Date.now() / 1000) }, null, 2),
    "utf-8"
  );
}

function truncatePayload(payload: string): string {
  const MAX_BYTES = 4096;
  if (payload.length <= MAX_BYTES) {
    return payload;
  }
  return payload.slice(0, MAX_BYTES) + "… (truncated)";
}

function buildMessage(payload: NotificationPayload): string {
  const eventSummary = payload.eventPayload
    ? truncatePayload(JSON.stringify(payload.eventPayload))
    : "";
  return `🔔 [${payload.boardSlug}] Task #${payload.taskId}: ${payload.title}\nStatus: ${payload.eventKind}\n${eventSummary}`.trim();
}

async function sendTelegram(profile: NotifierProfile, sub: Pick<NotifySubShape, "chat_id" | "thread_id" | "user_id">, text: string): Promise<void> {
  const token = profile.config.bot_token;
  const url = `https://api.telegram.org/bot${token}/sendMessage`;
  const body: Record<string, string> = { chat_id: sub.chat_id, text };
  if (sub.thread_id) {
    body.message_thread_id = sub.thread_id;
  }
  await postJson(url, body);
}

async function sendSlack(profile: NotifierProfile, sub: Pick<NotifySubShape, "chat_id" | "thread_id" | "user_id">, text: string): Promise<void> {
  const url = profile.config.webhook_url;
  const body: Record<string, string> = { channel: sub.chat_id, text };
  await postJson(url, body);
}

async function sendDiscord(profile: NotifierProfile, _sub: Pick<NotifySubShape, "chat_id" | "thread_id" | "user_id">, text: string): Promise<void> {
  const url = profile.config.webhook_url;
  await postJson(url, { content: text });
}

async function sendWebhook(profile: NotifierProfile, sub: Pick<NotifySubShape, "chat_id" | "thread_id" | "user_id">, payload: NotificationPayload): Promise<void> {
  const url = profile.config.url;
  const body = {
    chat_id: sub.chat_id,
    thread_id: sub.thread_id,
    user_id: sub.user_id,
    text: payload.text,
    board_slug: payload.boardSlug,
    task_id: payload.taskId,
    title: payload.title,
    event_kind: payload.eventKind,
    event_payload: payload.eventPayload,
  };
  await postJson(url, body);
}

async function postJson(url: string, body: unknown): Promise<void> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    // Best-effort delivery: failures are logged but not propagated.
    console.warn(`Notification delivery failed for ${url}: ${(err as Error).message}`);
  } finally {
    clearTimeout(timeout);
  }
}

function sendLog(profile: NotifierProfile, sub: Pick<NotifySubShape, "chat_id" | "thread_id" | "user_id">, payload: NotificationPayload): void {
  const line = JSON.stringify({
    transport: profile.transport,
    profile: profile.name,
    chat_id: sub.chat_id,
    thread_id: sub.thread_id,
    user_id: sub.user_id,
    ...payload,
  });
  process.stderr.write(`${line}\n`);
}

type NotifySubShape = { chat_id: string; thread_id: string | null; user_id: string | null };

export async function sendNotification(
  profile: NotifierProfile,
  sub: Pick<NotifySubShape, "chat_id" | "thread_id" | "user_id">,
  payload: NotificationPayload
): Promise<void> {
  switch (profile.transport) {
    case "log":
      sendLog(profile, sub, payload);
      return;
    case "telegram":
      await sendTelegram(profile, sub, payload.text);
      return;
    case "slack":
      await sendSlack(profile, sub, payload.text);
      return;
    case "discord":
      await sendDiscord(profile, sub, payload.text);
      return;
    case "webhook":
      await sendWebhook(profile, sub, payload);
      return;
    default:
      // Should be caught by validation, but defensive fallback.
      console.warn(`Unsupported notifier transport: ${profile.transport}`);
  }
}

interface EventRow {
  id: number;
  task_id: number;
  kind: string;
  payload: string | null;
  created_at: number;
}

interface SubscriptionRow {
  id: number;
  platform: string;
  chat_id: string;
  thread_id: string | null;
  user_id: string | null;
  notifier_profile: string;
}

export async function runNotifierWatcher(boardSlug: string, lastSeenId: number): Promise<number> {
  const db = getDb();

  // Early exit if there are no active subscriptions on this board.
  const hasSubs = db.query(
    `SELECT 1
     FROM kanban_notify_subs s
     JOIN tasks t ON t.id = s.task_id
     JOIN boards b ON b.id = t.board_id
     WHERE b.slug = ? AND s.unsubscribed_at IS NULL AND t.archived_at IS NULL
     LIMIT 1`
  ).get(boardSlug) as { 1: number } | undefined;

  if (!hasSubs) {
    return lastSeenId;
  }

  const events = db.query(
    `SELECT e.id, e.task_id, e.kind, e.payload, e.created_at
     FROM task_events e
     JOIN tasks t ON t.id = e.task_id
     JOIN boards b ON b.id = t.board_id
     WHERE b.slug = ? AND t.archived_at IS NULL AND e.id > ?
     ORDER BY e.id ASC`
  ).all(boardSlug, lastSeenId) as EventRow[];

  let newLastSeen = lastSeenId;

  for (const event of events) {
    const subscriptions = db.query(
      `SELECT s.id, s.platform, s.chat_id, s.thread_id, s.user_id, s.notifier_profile
       FROM kanban_notify_subs s
       JOIN tasks t ON t.id = s.task_id
       WHERE s.task_id = ? AND s.unsubscribed_at IS NULL AND t.archived_at IS NULL`
    ).all(event.task_id) as SubscriptionRow[];

    if (subscriptions.length === 0) {
      newLastSeen = event.id;
      continue;
    }

    const task = db.query(
      `SELECT id, title FROM tasks WHERE id = ? AND archived_at IS NULL`
    ).get(event.task_id) as { id: number; title: string } | undefined;

    if (!task) {
      newLastSeen = event.id;
      continue;
    }

    let eventPayload: Record<string, unknown> | null = null;
    if (event.payload) {
      try {
        eventPayload = JSON.parse(event.payload);
      } catch {
        eventPayload = { raw: event.payload };
      }
    }

    const text = buildMessage({
      boardSlug,
      taskId: task.id,
      title: task.title,
      eventKind: event.kind,
      eventPayload,
      text: "",
    });

    const payload: NotificationPayload = {
      boardSlug,
      taskId: task.id,
      title: task.title,
      eventKind: event.kind,
      eventPayload,
      text,
    };

    for (const sub of subscriptions) {
      try {
        const profile = getNotifier(sub.notifier_profile);
        await sendNotification(profile, sub, payload);
      } catch (err) {
        console.warn(`Notifier watcher skipped subscription ${sub.id}: ${(err as Error).message}`);
      }
    }

    newLastSeen = event.id;
  }

  return newLastSeen;
}
