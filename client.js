/**
 * 烧钱炉（token-furnace）—— Client 半侧。
 *
 * 注册一个 settings.section 当控制中心：设「跑几轮」「花到多少」，开始/停止，
 * 实时看烧掉了多少。所有操作都走 Host 半侧的 /dsh-token-furnace 路由。
 */

window.__ModuleLoader__.load({
  id: '@local/dsh-token-furnace',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = '/dsh-token-furnace';
    const POLL_MS = 1200;

    const CSS = `
.__tf_root { display:flex; flex-direction:column; gap:20px; padding:2px 0 28px; }
.__tf_hero { display:flex; flex-direction:column; gap:10px; padding:14px 16px; border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); }
.__tf_heroTop { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
.__tf_badge { font-size:12px; line-height:18px; padding:1px 8px; border-radius:999px; border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-secondary); white-space:nowrap; }
.__tf_badge[data-on="true"] { border-color:transparent; background:var(--dsw-alias-brand-primary); color:#fff; }
.__tf_meter { font-size:13px; color:var(--dsw-alias-label-primary); font-variant-numeric:tabular-nums; }
.__tf_bar { height:6px; border-radius:999px; overflow:hidden; background:var(--dsw-alias-bg-layer-2); }
.__tf_barFill { height:100%; border-radius:999px; background:var(--dsw-alias-brand-primary); transition:width .3s ease; }
.__tf_foot { font-size:12px; line-height:1.6; color:var(--dsw-alias-label-tertiary); font-variant-numeric:tabular-nums; }
.__tf_group { display:flex; flex-direction:column; }
.__tf_groupTitle { margin-bottom:6px; font-size:12px; font-weight:600; letter-spacing:.02em; color:var(--dsw-alias-label-secondary); }
.__tf_row { display:flex; align-items:center; gap:16px; padding:10px 0; border-bottom:1px solid var(--dsw-alias-border-l1); }
.__tf_row:last-child { border-bottom:0; }
.__tf_rowMain { flex:1 1 auto; min-width:0; }
.__tf_rowLabel { font-size:13px; color:var(--dsw-alias-label-primary); }
.__tf_rowHint { margin-top:2px; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-tertiary); }
.__tf_num { width:132px; height:32px; box-sizing:border-box; padding:0 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-base); color:var(--dsw-alias-label-primary); font-size:13px; font-variant-numeric:tabular-nums; outline:none; }
.__tf_num:focus { border-color:var(--dsw-alias-brand-primary); }
.__tf_actions { display:flex; gap:8px; flex-wrap:wrap; }
.__tf_btn { height:32px; padding:0 14px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); font-size:13px; cursor:pointer; }
.__tf_btn:hover:not(:disabled) { border-color:var(--dsw-alias-border-l2); }
.__tf_btn:disabled { opacity:.45; cursor:not-allowed; }
.__tf_btn[data-tone="primary"] { border-color:transparent; background:var(--dsw-alias-brand-primary); color:#fff; }
.__tf_btn[data-tone="danger"] { color:var(--dsw-alias-state-error-primary); }
.__tf_note { display:flex; flex-direction:column; gap:8px; }
.__tf_noteHead { font-size:12px; color:var(--dsw-alias-label-secondary); }
.__tf_noteBody { font-size:12px; line-height:1.65; color:var(--dsw-alias-label-tertiary); white-space:pre-wrap; word-break:break-word; }
.__tf_error { font-size:12px; line-height:1.6; color:var(--dsw-alias-state-error-primary); }
`;

    const STOP_REASON = {
      rounds: '跑够轮数，自己停了',
      spend: '钱花到上限，自己停了',
      manual: '手动停的',
      error: '出错停了',
    };

    function money(n) {
      const value = typeof n === 'number' && Number.isFinite(n) ? n : 0;
      return value >= 1 ? value.toFixed(3) : value.toFixed(4);
    }

    function tokens(n) {
      const value = typeof n === 'number' && Number.isFinite(n) ? n : 0;
      return value >= 10000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
    }

    function toNumber(raw, fallback) {
      const n = typeof raw === 'number' ? raw : Number.parseFloat(String(raw ?? ''));
      return Number.isFinite(n) ? n : fallback;
    }

    function Field(props) {
      return h(
        'div',
        { className: '__tf_row' },
        h(
          'div',
          { className: '__tf_rowMain' },
          h('div', { className: '__tf_rowLabel' }, props.label),
          props.hint ? h('div', { className: '__tf_rowHint' }, props.hint) : null,
        ),
        props.children,
      );
    }

    function TokenFurnacePanel() {
      const [state, setState] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [error, setError] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const touched = React.useRef(false);

      function applyState(json) {
        if (!json || json.ok !== true) return;
        setState(json);
        if (!touched.current && json.config) {
          setDraft({
            maxRounds: String(json.config.maxRounds),
            maxSpendYuan: String(json.config.maxSpendYuan),
            priceInputPerMillion: String(json.config.priceInputPerMillion),
            priceOutputPerMillion: String(json.config.priceOutputPerMillion),
          });
        }
      }

      React.useEffect(() => {
        let alive = true;
        function load() {
          fetch(`${API}/state`, { headers: { Accept: 'application/json' } })
            .then((r) => r.json())
            .then((json) => {
              if (alive) applyState(json);
            })
            .catch((err) => {
              if (alive) setError(`读不到状态：${err && err.message ? err.message : err}`);
            });
        }
        load();
        const timer = setInterval(load, POLL_MS);
        return () => {
          alive = false;
          clearInterval(timer);
        };
      }, []);

      function patchDraft(key, value) {
        touched.current = true;
        setDraft((prev) => Object.assign({}, prev, { [key]: value }));
      }

      function commit() {
        if (!draft) return Promise.resolve();
        const patch = {
          maxRounds: toNumber(draft.maxRounds, 5),
          maxSpendYuan: toNumber(draft.maxSpendYuan, 0.5),
          priceInputPerMillion: toNumber(draft.priceInputPerMillion, 2),
          priceOutputPerMillion: toNumber(draft.priceOutputPerMillion, 8),
        };
        return fetch(`${API}/config`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ patch }),
        })
          .then((r) => r.json())
          .then((json) => {
            if (json && json.ok === true) {
              touched.current = false;
              setDraft({
                maxRounds: String(json.config.maxRounds),
                maxSpendYuan: String(json.config.maxSpendYuan),
                priceInputPerMillion: String(json.config.priceInputPerMillion),
                priceOutputPerMillion: String(json.config.priceOutputPerMillion),
              });
              setError(null);
            } else {
              setError((json && json.error) || '保存失败');
            }
          })
          .catch((err) => setError(`保存失败：${err && err.message ? err.message : err}`));
      }

      function post(route, body) {
        setBusy(true);
        setError(null);
        return fetch(`${API}${route}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body || {}),
        })
          .then((r) => r.json())
          .then((json) => {
            if (!json || json.ok !== true) throw new Error((json && json.error) || '操作失败');
            applyState(json);
          })
          .catch((err) => setError(err && err.message ? err.message : String(err)))
          .then(() => setBusy(false));
      }

      function start() {
        if (!draft) return;
        const patch = {
          maxRounds: toNumber(draft.maxRounds, 5),
          maxSpendYuan: toNumber(draft.maxSpendYuan, 0.5),
          priceInputPerMillion: toNumber(draft.priceInputPerMillion, 2),
          priceOutputPerMillion: toNumber(draft.priceOutputPerMillion, 8),
        };
        return post('/start', { patch });
      }

      if (!state) {
        return h(
          'div',
          { className: '__tf_root' },
          h('style', { key: 'css' }, CSS),
          h('div', { className: '__tf_foot' }, error || '读取中…'),
        );
      }

      const running = state.running === true;
      const maxRounds = Math.max(1, toNumber(state.config.maxRounds, 5));
      const maxSpend = Math.max(0.000001, toNumber(state.config.maxSpendYuan, 0.5));
      const roundPct = Math.min(100, (state.rounds / maxRounds) * 100);
      const spendPct = Math.min(100, (state.spendYuan / maxSpend) * 100);
      const pct = Math.max(roundPct, spendPct);
      const stopNote = state.stopReason && !running ? STOP_REASON[state.stopReason] : null;

      return h(
        'div',
        { className: '__tf_root' },
        h('style', { key: 'css' }, CSS),

        h(
          'div',
          { className: '__tf_hero' },
          h(
            'div',
            { className: '__tf_heroTop' },
            h('span', { className: '__tf_badge', 'data-on': running ? 'true' : 'false' }, running ? '焚烧中' : '待机'),
            h(
              'span',
              { className: '__tf_meter' },
              `${state.rounds} / ${maxRounds} 轮 · ¥${money(state.spendYuan)} / ¥${money(maxSpend)}`,
            ),
          ),
          h('div', { className: '__tf_bar' }, h('div', { className: '__tf_barFill', style: { width: `${pct}%` } })),
          h(
            'div',
            { className: '__tf_foot' },
            `输入 ${tokens(state.inputTokens)} tok · 输出 ${tokens(state.outputTokens)} tok` +
              (state.estimated ? ' · 含估算' : '') +
              (state.model ? ` · ${state.model}` : '') +
              (stopNote ? ` · ${stopNote}` : ''),
          ),
        ),

        h(
          'div',
          { className: '__tf_group' },
          h('div', { className: '__tf_groupTitle' }, '闸门'),
          h(
            Field,
            { label: '跑几轮', hint: '跑够这么多轮就自动停' },
            h('input', {
              className: '__tf_num',
              type: 'number',
              min: 1,
              step: 1,
              value: draft ? draft.maxRounds : '',
              disabled: running,
              onChange: (e) => patchDraft('maxRounds', e.target.value),
              onBlur: commit,
            }),
          ),
          h(
            Field,
            { label: '花到多少（元）', hint: '按下面的单价估算，花到这个数就自动停' },
            h('input', {
              className: '__tf_num',
              type: 'number',
              min: 0,
              step: 0.01,
              value: draft ? draft.maxSpendYuan : '',
              disabled: running,
              onChange: (e) => patchDraft('maxSpendYuan', e.target.value),
              onBlur: commit,
            }),
          ),
          h(
            Field,
            { label: '输入单价', hint: '元 / 百万 token' },
            h('input', {
              className: '__tf_num',
              type: 'number',
              min: 0,
              step: 0.1,
              value: draft ? draft.priceInputPerMillion : '',
              disabled: running,
              onChange: (e) => patchDraft('priceInputPerMillion', e.target.value),
              onBlur: commit,
            }),
          ),
          h(
            Field,
            { label: '输出单价', hint: '元 / 百万 token' },
            h('input', {
              className: '__tf_num',
              type: 'number',
              min: 0,
              step: 0.1,
              value: draft ? draft.priceOutputPerMillion : '',
              disabled: running,
              onChange: (e) => patchDraft('priceOutputPerMillion', e.target.value),
              onBlur: commit,
            }),
          ),
        ),

        h(
          'div',
          { className: '__tf_actions' },
          h(
            'button',
            { className: '__tf_btn', 'data-tone': 'primary', disabled: running || busy, onClick: start },
            running ? '正在烧…' : '开始烧',
          ),
          h(
            'button',
            { className: '__tf_btn', 'data-tone': 'danger', disabled: !running || busy, onClick: () => post('/stop') },
            '停下来',
          ),
          h(
            'button',
            { className: '__tf_btn', disabled: running || busy, onClick: () => post('/reset') },
            '归零',
          ),
        ),

        error ? h('div', { className: '__tf_error' }, error) : null,

        state.lastQuestion
          ? h(
              'div',
              { className: '__tf_note' },
              h('div', { className: '__tf_noteHead' }, '最近一问'),
              h('div', { className: '__tf_noteBody' }, state.lastQuestion),
              state.lastAnswer ? h('div', { className: '__tf_noteHead' }, '它认真答的') : null,
              state.lastAnswer ? h('div', { className: '__tf_noteBody' }, state.lastAnswer) : null,
            )
          : h(
              'div',
              { className: '__tf_note' },
              h(
                'div',
                { className: '__tf_noteBody' },
                '炉子还凉着。设好闸门，点「开始烧」，它会开始一本正经地思考一些没什么意义的问题。',
              ),
            ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'token-furnace', order: 27, label: '烧钱炉' },
            TokenFurnacePanel,
          ),
        );
      },
    };
  },
});
