#!/usr/bin/env node
/**
 * FlowAI Studio — 演示用 MCP Server
 *
 * 协议：MCP (Model Context Protocol) 2024-11-05
 * 传输：stdio，消息格式为「一行一个 JSON-RPC 2.0 对象」（NDJSON）
 * 依赖：无，只用 Node 内置模块
 *
 * 启动方式（由 MCP 客户端以子进程方式拉起，不需要手动运行）：
 *   node scripts/mcp-demo-server.js
 *
 * 关键约定：stdout 只能输出协议消息，日志一律写 stderr。
 * 客户端按行解析 stdout，混进任何非 JSON 内容都会被当成协议噪音。
 */
const readline = require('readline');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'flowai-demo-server', version: '1.0.0' };

// ============================================================
// 工具实现
// ============================================================

/** 模拟的订单系统数据（演示用，代表一个外部业务系统） */
const ORDERS = {
  A1001: { item: '机械键盘 K8', amount: 399, status: '已发货', carrier: '顺丰', trackingNo: 'SF1234567890', updatedAt: '2026-09-25 14:20' },
  A1002: { item: '降噪耳机 WH-2', amount: 1299, status: '待支付', updatedAt: '2026-09-26 09:05' },
  A1003: { item: '显示器支架', amount: 189, status: '已签收', carrier: '中通', trackingNo: 'ZT9876543210', updatedAt: '2026-09-22 18:40' },
};

/** FNV-1a 哈希，用于让模拟天气在同一天内对同一城市保持稳定 */
function hashString(s) {
  let h = 2166136261;
  for (const ch of s) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * 安全的四则运算求值：递归下降解析，不使用 eval
 *
 *   expr  := term (('+' | '-') term)*
 *   term  := unary (('*' | '/' | '%') unary)*
 *   unary := ('-' | '+') unary | power
 *   power := primary ('^' unary)?        // 右结合，且 -2^2 = -4
 *   primary := number | '(' expr ')'
 */
function evaluate(expression) {
  const src = expression.replace(/\s+/g, '');
  if (!src) throw new Error('表达式为空');
  if (!/^[\d+\-*/().%^]+$/.test(src)) {
    throw new Error('只支持数字和 + - * / % ^ ( )');
  }

  let pos = 0;
  const eat = (ch) => (src[pos] === ch ? (pos++, true) : false);
  const fail = () => { throw new Error(`第 ${pos + 1} 个字符附近无法解析`); };

  function parseExpr() {
    let v = parseTerm();
    for (;;) {
      if (eat('+')) v += parseTerm();
      else if (eat('-')) v -= parseTerm();
      else return v;
    }
  }
  function parseTerm() {
    let v = parseUnary();
    for (;;) {
      if (eat('*')) v *= parseUnary();
      else if (eat('/')) { const d = parseUnary(); if (d === 0) throw new Error('除数不能为 0'); v /= d; }
      else if (eat('%')) { const d = parseUnary(); if (d === 0) throw new Error('除数不能为 0'); v %= d; }
      else return v;
    }
  }
  function parseUnary() {
    if (eat('-')) return -parseUnary();
    if (eat('+')) return parseUnary();
    return parsePower();
  }
  function parsePower() {
    const base = parsePrimary();
    return eat('^') ? Math.pow(base, parseUnary()) : base;
  }
  function parsePrimary() {
    if (eat('(')) {
      const v = parseExpr();
      if (!eat(')')) throw new Error('括号不匹配');
      return v;
    }
    const m = /^\d+(\.\d+)?/.exec(src.slice(pos));
    if (!m) fail();
    pos += m[0].length;
    return parseFloat(m[0]);
  }

  const result = parseExpr();
  if (pos !== src.length) fail();
  if (!Number.isFinite(result)) throw new Error('结果不是有限数值');
  // 消除 0.1 + 0.2 = 0.30000000000000004 这类浮点尾巴
  return Number(result.toPrecision(12));
}

const TOOLS = [
  {
    name: 'get_current_time',
    description: '查询指定时区的当前时间',
    inputSchema: {
      type: 'object',
      properties: {
        timezone: { type: 'string', description: 'IANA 时区名，如 Asia/Shanghai、America/New_York，默认 Asia/Shanghai' },
      },
    },
    handler({ timezone }) {
      const tz = timezone || 'Asia/Shanghai';
      let fmt;
      try {
        fmt = new Intl.DateTimeFormat('zh-CN', { timeZone: tz, dateStyle: 'full', timeStyle: 'medium' });
      } catch {
        throw new Error(`无效的时区：${tz}（示例：Asia/Shanghai、America/New_York）`);
      }
      return `${tz} 当前时间：${fmt.format(new Date())}`;
    },
  },
  {
    name: 'get_weather',
    description: '查询城市今日天气（演示数据，非真实天气）',
    inputSchema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，如 深圳、香港' },
      },
      required: ['city'],
    },
    handler({ city }) {
      const today = new Date().toISOString().slice(0, 10);
      const h = hashString(city + today);
      const conditions = ['晴', '多云', '阴', '小雨', '雷阵雨'];
      const temp = 12 + (h % 20);
      const condition = conditions[(h >>> 5) % conditions.length];
      const humidity = 40 + ((h >>> 10) % 50);
      return `${city} ${today} 天气（演示数据）：${condition}，${temp}°C，湿度 ${humidity}%`;
    },
  },
  {
    name: 'calculate',
    description: '计算数学表达式，支持 + - * / % ^ 和括号',
    inputSchema: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: '数学表达式，如 (128+64)*3/2' },
      },
      required: ['expression'],
    },
    handler({ expression }) {
      return `${expression} = ${evaluate(expression)}`;
    },
  },
  {
    name: 'query_order',
    description: '查询订单状态（模拟的外部订单系统，可用单号：A1001、A1002、A1003）',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: '订单号，如 A1001' },
      },
      required: ['order_id'],
    },
    handler({ order_id }) {
      const id = order_id.trim().toUpperCase();
      const order = ORDERS[id];
      if (!order) throw new Error(`订单 ${id} 不存在（可用单号：${Object.keys(ORDERS).join('、')}）`);
      const lines = [
        `订单号：${id}`,
        `商品：${order.item}`,
        `金额：¥${order.amount}`,
        `状态：${order.status}`,
      ];
      if (order.carrier) lines.push(`物流：${order.carrier} ${order.trackingNo}`);
      lines.push(`更新时间：${order.updatedAt}`);
      return lines.join('\n');
    },
  },
];

// ============================================================
// JSON-RPC 2.0 / MCP 协议层
// ============================================================

function send(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function log(...parts) {
  process.stderr.write(`[flowai-demo-mcp] ${parts.join(' ')}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

/** 按 inputSchema 做最基本的必填与类型校验 */
function validateArgs(schema, args) {
  for (const key of schema.required || []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      return `缺少必填参数：${key}`;
    }
  }
  for (const [key, def] of Object.entries(schema.properties || {})) {
    const v = args[key];
    if (v === undefined || v === null || v === '') continue;
    if (def.type === 'string' && typeof v !== 'string') return `参数 ${key} 应为字符串`;
    if (def.type === 'number' && typeof v !== 'number') return `参数 ${key} 应为数字`;
  }
  return null;
}

/**
 * tools/call
 *
 * 按 MCP 规范区分两类错误：
 * - 协议层错误（工具不存在）→ JSON-RPC error
 * - 工具执行错误（参数不对、业务失败）→ 正常 result，带 isError: true，
 *   这样调用方（通常是大模型）能读到错误原因并自行修正重试
 */
function handleToolCall(id, params) {
  const tool = TOOLS.find((t) => t.name === params?.name);
  if (!tool) return replyError(id, -32602, `Unknown tool: ${params?.name}`);

  const args = params.arguments || {};
  const invalid = validateArgs(tool.inputSchema, args);
  if (invalid) {
    return reply(id, { content: [{ type: 'text', text: invalid }], isError: true });
  }

  try {
    const text = tool.handler(args);
    log(`tools/call ${tool.name} 成功`);
    reply(id, { content: [{ type: 'text', text }] });
  } catch (err) {
    log(`tools/call ${tool.name} 失败：${err.message}`);
    reply(id, { content: [{ type: 'text', text: err.message }], isError: true });
  }
}

function handleMessage(msg) {
  const isNotification = msg.id === undefined || msg.id === null;

  switch (msg.method) {
    case 'initialize':
      log(`initialize，客户端：${msg.params?.clientInfo?.name ?? '未知'}`);
      return reply(msg.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      });

    case 'notifications/initialized':
      log('握手完成');
      return;

    case 'ping':
      return reply(msg.id, {});

    case 'tools/list':
      // 去掉 handler，只把工具的声明部分发给客户端
      return reply(msg.id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });

    case 'tools/call':
      return handleToolCall(msg.id, msg.params);

    default:
      // 未知通知直接忽略；未知请求按 JSON-RPC 规范返回 -32601
      if (!isNotification) replyError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return replyError(null, -32700, 'Parse error');
  }

  try {
    handleMessage(msg);
  } catch (err) {
    log(`处理消息出错：${err.message}`);
    if (msg.id !== undefined && msg.id !== null) replyError(msg.id, -32603, 'Internal error');
  }
});

// 客户端断开（stdin 关闭）时退出，避免留下孤儿进程
rl.on('close', () => {
  log('stdin 已关闭，退出');
  process.exit(0);
});

log(`已启动，提供 ${TOOLS.length} 个工具：${TOOLS.map((t) => t.name).join(', ')}`);
