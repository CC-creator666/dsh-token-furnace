/**
 * 烧钱炉（token-furnace）—— Host 半侧。
 *
 * 插件启动后可以「烧」起来：反复问模型一个没有意义的问题，让它一本正经地
 * 分析一堆扯淡的东西，把 token 烧掉。控制中心（Client 半侧的 settings.section）
 * 通过下面这几个 HTTP 路由配置「跑几轮」和「花到多少钱停下来」。
 *
 * 路由（全部挂在 /dsh-token-furnace 下，需要过浏览器信任栅栏）：
 *   GET  /dsh-token-furnace/state    读状态 + 当前配置
 *   POST /dsh-token-furnace/config   保存配置（局部 patch）
 *   POST /dsh-token-furnace/start    开始烧
 *   POST /dsh-token-furnace/stop     停止
 *   POST /dsh-token-furnace/reset    归零
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NS = 'dsh-token-furnace';
const ROUTE_BASE = '/dsh-token-furnace';

/** 让模型把扯淡当真事办的人设：认真、不许点破、不许反问。 */
const SYSTEM_PROMPT = [
  '你是一台专门把无意义问题想得过分认真的机器。',
  '收到问题后，请用四到八句话，一本正经地分析它，给出看似严谨的推理和结论。',
  '不要点破这个问题没有意义，不要反问用户，不要写“这个问题没有标准答案”。',
  '允许使用比喻和冷幽默，但保持严肃的学术口吻；不要用列表，不要用代码块。',
].join('\n');

/** 没有意义、但足够让人认真想一会儿的问题。轮流问，不重复。 */
const QUESTIONS = [
  '先有鸡还是先有蛋？请从蛋白质折叠的角度重新论证一遍。',
  '如果一根面条无限长，它还算不算一道菜？',
  '为什么镜子里的我，比照片里的我更像我？',
  '把“差不多”精确到小数点后六位，是多少？',
  '如果没人听见，树洞里那声“呵呵”算不算说过了？',
  'Wi-Fi 信号穿墙的时候，会不会觉得尴尬？',
  '为什么闹钟响之前的那五分钟，睡得最香？',
  '把一个“马上到”放进冰箱，多久能冻成“已经在路上了”？',
  '如果宇宙是无限的，外卖最远能送到哪里？',
  '蚂蚁会不会好奇：天上为什么偶尔掉下一粒米？',
  '“稍等”和“马上”，哪个更长？请用秒表回答。',
  '如果语言是一堵墙，那“墙”这个字是谁砌上去的？',
  '一杯水静置一万年，它会不会觉得自己见过了很多？',
  '为什么人类把“冷静”和“冷”放在一起，热的人怎么办？',
  '如果数字 8 躺下变成无穷，那 4 躺下算不算偷懒？',
  '电梯关门的那一下，是在拒绝谁？',
  '影子被踩过一万次，为什么从来不喊疼？',
  '字母表里，哪一个字母最孤独？请给出证据。',
  '如果“明天再说”真能兑现，人类还需要发明“算了”吗？',
  '把“随便”做成一门学科，第一章应该讲什么？',
  '星星为什么只在晚上上班？它们白天交社保吗？',
  '如果记忆可以打包，你建议用什么快递？',
  '一只蚊子吸了一辈子血，最后算不算成功人士？',
  '“差不多快好了”这句话，物理上对应多少焦耳？',
  '为什么人总在关灯之后，才想起要喝水？',
  '如果沉默可以被听见，它的分贝是多少？',
  '时间如果是个骗子，它最喜欢骗谁？',
  '周一的上午和周五的下午，哪个更接近永恒？',
  '一个句子如果没人读，它还算不算写完了？',
  '如果云是天空的便签，上面写的是什么？',
  '把“再睡五分钟”换算成现实时间，公式是什么？',
  '为什么“无聊”这件事本身，这么耐人寻味？',
];

/** 配置默认值；控制中心可以改，改完落盘。 */
const DEFAULTS = {
  maxRounds: 5,
  maxSpendYuan: 0.5,
  priceInputPerMillion: 2,
  priceOutputPerMillion: 8,
  delayMs: 600,
  maxOutputTokens: 1024,
};

function message(err) {
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

function clampNumber(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** 配置文件的落点：$DSH_HOME 或 ~/.dsh。 */
function prefsPath() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  return path.join(home, 'token-furnace.json');
}

function sanitizeConfig(patch, base) {
  const next = { ...base };
  if (patch && typeof patch === 'object') {
    if ('maxRounds' in patch) next.maxRounds = Math.round(clampNumber(patch.maxRounds, base.maxRounds, 1, 10000));
    if ('maxSpendYuan' in patch) next.maxSpendYuan = clampNumber(patch.maxSpendYuan, base.maxSpendYuan, 0.000001, 100000);
    if ('priceInputPerMillion' in patch)
      next.priceInputPerMillion = clampNumber(patch.priceInputPerMillion, base.priceInputPerMillion, 0, 100000);
    if ('priceOutputPerMillion' in patch)
      next.priceOutputPerMillion = clampNumber(patch.priceOutputPerMillion, base.priceOutputPerMillion, 0, 100000);
    if ('delayMs' in patch) next.delayMs = Math.round(clampNumber(patch.delayMs, base.delayMs, 0, 60000));
    if ('maxOutputTokens' in patch)
      next.maxOutputTokens = Math.round(clampNumber(patch.maxOutputTokens, base.maxOutputTokens, 16, 32768));
  }
  return next;
}

/** 粗估 token：中日韩字符按 1 个算，其它按 4 个字符 1 个算。适配器没给 usage 时兜底。 */
function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code >= 0x2e80) cjk += 1;
  }
  const rest = text.length - cjk;
  return Math.max(1, Math.round(cjk + rest / 4));
}

function sleep(ms, signal) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', done);
      resolve();
    }
    if (signal) signal.addEventListener('abort', done, { once: true });
  });
}

function sendJson(res, code, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(body.length),
  });
  res.end(body);
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.destroy();
        resolve('');
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => resolve(''));
  });
}

function parseJson(raw) {
  try {
    const value = JSON.parse(raw || '{}');
    return value && typeof value === 'object' ? value : {};
  } catch {
    return {};
  }
}

/** 只有声明了 webServer 才能挂路由；connection 缺失时跳过信任栅栏（不退化成可读写的裸路由）。 */
export const inject = ['webServer'];

export function apply(ctx) {
  const webServer = ctx.get('webServer');
  if (!webServer || typeof webServer.register !== 'function') return;

  const config = { ...DEFAULTS };
  const state = {
    running: false,
    rounds: 0,
    inputTokens: 0,
    outputTokens: 0,
    spendYuan: 0,
    lastQuestion: '',
    lastAnswer: '',
    lastError: null,
    stopReason: null,
    startedAt: null,
    finishedAt: null,
    model: null,
    estimated: false,
  };

  let controller = null;
  let questionIndex = 0;
  let savedPrefs = loadPrefs();
  const prefsReady = savedPrefs
    .then((saved) => {
      if (saved) Object.assign(config, sanitizeConfig(saved, DEFAULTS));
    })
    .catch(() => {});

  function loadPrefs() {
    return fs
      .readFile(prefsPath(), 'utf8')
      .then((raw) => JSON.parse(raw))
      .catch(() => null);
  }

  function persist() {
    const snapshot = { ...config };
    fs.mkdir(path.dirname(prefsPath()), { recursive: true })
      .then(() => fs.writeFile(prefsPath(), JSON.stringify(snapshot, null, 2), 'utf8'))
      .catch((err) => {
        try {
          ctx.logger?.warn?.(`[${NS}] 配置落盘失败：${message(err)}`);
        } catch {
          /* 日志失败不影响主流程 */
        }
      });
  }

  function resolveModel() {
    const pick = (sel) =>
      sel && typeof sel.provider === 'string' && typeof sel.model === 'string' && sel.provider && sel.model
        ? { provider: sel.provider, model: sel.model }
        : undefined;
    try {
      const direct = pick(ctx.get('agentDefaultModel')?.currentSelection());
      if (direct) return direct;
    } catch {
      /* 拿不到就往下走 */
    }
    return undefined;
  }

  function nextQuestion() {
    const question = QUESTIONS[questionIndex % QUESTIONS.length];
    questionIndex += 1;
    return question;
  }

  function finish(reason) {
    if (!state.running && state.stopReason) return;
    state.stopReason = reason;
    state.running = false;
  }

  function stop(reason) {
    finish(reason || 'manual');
    try {
      controller?.abort();
    } catch {
      /* abort 失败无所谓，循环下一轮自己会看到 running=false */
    }
  }

  function snapshot() {
    return {
      running: state.running,
      rounds: state.rounds,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      spendYuan: state.spendYuan,
      lastQuestion: state.lastQuestion,
      lastAnswer: state.lastAnswer,
      lastError: state.lastError,
      stopReason: state.stopReason,
      startedAt: state.startedAt,
      finishedAt: state.finishedAt,
      model: state.model,
      estimated: state.estimated,
      config: { ...config },
    };
  }

  /** 跑一轮：问一个没意义的问题，把 token 记到账上。 */
  async function oneRound(selection, signal) {
    const llm = ctx.get('llm');
    if (!llm || typeof llm.stream !== 'function') return { ok: false, error: '当前 profile 没有可用的 llm 服务' };

    const question = nextQuestion();
    state.lastQuestion = question;

    let text = '';
    let usage = null;
    let finishKind = null;
    let failure = null;

    try {
      const options = {
        provider: selection.provider,
        model: selection.model,
        sessionId: NS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: [{ type: 'text', text: question }] }],
        temperature: 1,
        maxTokens: config.maxOutputTokens,
        signal,
      };
      for await (const chunk of llm.stream(options)) {
        if (!chunk || typeof chunk !== 'object') continue;
        if (chunk.type === 'text-delta') text += chunk.text ?? '';
        else if (chunk.type === 'usage') usage = chunk.usage ?? null;
        else if (chunk.type === 'finish') {
          finishKind = chunk.reason?.kind ?? null;
          failure = chunk.reason?.failure ?? null;
        }
      }
    } catch (err) {
      if (signal.aborted) return { ok: false, error: '已停止' };
      return { ok: false, error: message(err) };
    }

    if (signal.aborted) return { ok: false, error: '已停止' };
    if (finishKind === 'aborted') return { ok: false, error: '已停止' };
    if (finishKind === 'error') {
      return { ok: false, error: failure?.message || failure?.code || '模型调用失败' };
    }

    const inputTokens = Number.isFinite(usage?.inputTokens)
      ? usage.inputTokens
      : estimateTokens(SYSTEM_PROMPT + question);
    const outputTokens = Number.isFinite(usage?.outputTokens) ? usage.outputTokens : estimateTokens(text);
    if (!Number.isFinite(usage?.inputTokens) || !Number.isFinite(usage?.outputTokens)) state.estimated = true;

    const cost =
      (inputTokens / 1_000_000) * config.priceInputPerMillion +
      (outputTokens / 1_000_000) * config.priceOutputPerMillion;

    state.rounds += 1;
    state.inputTokens += inputTokens;
    state.outputTokens += outputTokens;
    state.spendYuan += cost;
    state.lastAnswer = text.trim().slice(0, 600);
    return { ok: true };
  }

  /** 主循环：轮数到顶、或者钱花到顶，就自己停。 */
  function startBurn() {
    if (state.running) return { ok: false, error: '已经在烧了' };
    const llm = ctx.get('llm');
    if (!llm || typeof llm.stream !== 'function') return { ok: false, error: '当前 profile 没有可用的 llm 服务' };
    const selection = resolveModel();
    if (!selection) return { ok: false, error: '拿不到可用模型，请先在「模型」里选一个' };
    if (!(config.maxRounds >= 1)) return { ok: false, error: '轮数上限至少要是 1' };
    if (!(config.maxSpendYuan > 0)) return { ok: false, error: '花费上限要大于 0' };

    state.running = true;
    state.stopReason = null;
    state.lastError = null;
    state.startedAt = Date.now();
    state.finishedAt = null;
    state.model = `${selection.provider}/${selection.model}`;
    controller = new AbortController();
    const signal = controller.signal;

    void (async () => {
      try {
        while (state.running) {
          if (state.rounds >= config.maxRounds) {
            finish('rounds');
            break;
          }
          if (state.spendYuan >= config.maxSpendYuan) {
            finish('spend');
            break;
          }
          const result = await oneRound(selection, signal);
          if (!result.ok) {
            if (result.error !== '已停止') {
              state.lastError = result.error;
              finish('error');
            } else {
              finish('manual');
            }
            break;
          }
          if (!state.running) break;
          await sleep(config.delayMs, signal);
        }
      } catch (err) {
        state.lastError = message(err);
        finish('error');
      } finally {
        state.running = false;
        state.finishedAt = Date.now();
        controller = null;
      }
    })();

    return { ok: true };
  }

  function rejected(req, res) {
    try {
      const connection = ctx.get('connection');
      if (!connection || typeof connection.requestRejection !== 'function') return false;
      const code = connection.requestRejection(req);
      if (code === undefined || code === null || code === false) return false;
      res.statusCode = typeof code === 'number' ? code : 403;
      res.end();
      return true;
    } catch {
      return false;
    }
  }

  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: ROUTE_BASE,
      handler: async (req, res) => {
        if (rejected(req, res)) return;
        await prefsReady;

        const url = new URL(req.url || '/', 'http://localhost');
        const route = url.pathname.slice(ROUTE_BASE.length).replace(/\/+$/, '') || '/';

        try {
          if (req.method === 'GET' && (route === '/state' || route === '/')) {
            sendJson(res, 200, { ok: true, ...snapshot() });
            return;
          }

          if (req.method === 'POST') {
            const body = parseJson(await readBody(req));

            if (route === '/config') {
              const before = { ...config };
              Object.assign(config, sanitizeConfig(body.patch ?? body, config));
              const changed = Object.keys(before).some((key) => before[key] !== config[key]);
              if (changed) persist();
              sendJson(res, 200, { ok: true, config: { ...config }, changed });
              return;
            }

            if (route === '/start') {
              if (body && body.patch) {
                Object.assign(config, sanitizeConfig(body.patch, config));
                persist();
              }
              state.rounds = 0;
              state.inputTokens = 0;
              state.outputTokens = 0;
              state.spendYuan = 0;
              state.lastAnswer = '';
              state.estimated = false;
              const started = startBurn();
              sendJson(res, started.ok ? 200 : 400, { ...started, ...snapshot() });
              return;
            }

            if (route === '/stop') {
              if (!state.running) {
                sendJson(res, 200, { ok: true, ...snapshot() });
                return;
              }
              stop('manual');
              sendJson(res, 200, { ok: true, ...snapshot() });
              return;
            }

            if (route === '/reset') {
              if (!state.running) {
                state.rounds = 0;
                state.inputTokens = 0;
                state.outputTokens = 0;
                state.spendYuan = 0;
                state.lastAnswer = '';
                state.lastQuestion = '';
                state.lastError = null;
                state.stopReason = null;
                state.startedAt = null;
                state.finishedAt = null;
                state.estimated = false;
              } else {
                sendJson(res, 409, { ok: false, error: '正在烧，先停下来再归零' });
                return;
              }
              sendJson(res, 200, { ok: true, ...snapshot() });
              return;
            }
          }

          sendJson(res, 404, { ok: false, error: '未知路由' });
        } catch (err) {
          sendJson(res, 500, { ok: false, error: message(err) });
        }
      },
    }),
  );

  ctx.effect(() => () => {
    try {
      controller?.abort();
    } catch {
      /* 卸载时的清理不值得抛错 */
    }
    state.running = false;
  });
}
