'use strict';
// Ferramentas que a IA pode usar: agenda e tarefas (Google), busca na internet e, depois, o Spotify.
// Cada ferramenta devolve um TEXTO curto em português para o modelo falar com naturalidade.
// Erros também viram texto (nunca lançam): o modelo explica o problema ao usuário.

const dateFmt = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
const timeFmt = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit', hour12: false });

/** "segunda-feira, 5 de outubro, 10:00" (ou sem hora, para dia inteiro). */
function when(iso, allDay) {
  const d = new Date(allDay ? `${iso}T12:00:00` : iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return allDay ? dateFmt.format(d) : `${dateFmt.format(d)}, ${timeFmt.format(d)}`;
}

function describeEvent(e) {
  const end = e.end && !e.allDay ? ` até ${timeFmt.format(new Date(e.end))}` : '';
  const where = e.location ? ` | local: ${e.location}` : '';
  return `id=${e.id} | ${e.title} | ${when(e.start, e.allDay)}${e.allDay ? ' (dia inteiro)' : end}${where}`;
}

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
const bool = (v) => v === true || v === 'true';

const DEFS = {
  pesquisar_na_internet: {
    description: 'Pesquisa na internet informações atuais ou que você não sabe: notícias de agora, resultado e horário de jogos, cotações, preços, clima de outras cidades, fatos recentes.',
    parameters: { type: 'object', properties: { consulta: { type: 'string', description: 'O que pesquisar, em português, como uma frase de busca.' } }, required: ['consulta'] },
  },
  agenda_listar: {
    description: 'Lista os compromissos do Google Agenda entre duas datas. Use também antes de mudar ou apagar um compromisso, para pegar o id.',
    parameters: { type: 'object', properties: {
      inicio: { type: 'string', description: 'Início do período, data e hora ISO, ex.: 2026-10-05T00:00:00' },
      fim: { type: 'string', description: 'Fim do período, data e hora ISO, ex.: 2026-10-05T23:59:59' },
    }, required: ['inicio', 'fim'] },
  },
  agenda_criar: {
    description: 'Cria um compromisso no Google Agenda.',
    parameters: { type: 'object', properties: {
      titulo: { type: 'string' },
      inicio: { type: 'string', description: 'ISO, ex.: 2026-10-07T15:00:00. Para dia inteiro, só a data: 2026-10-07' },
      fim: { type: 'string', description: 'ISO. Se faltar, o compromisso dura 1 hora.' },
      dia_inteiro: { type: 'boolean' },
      local: { type: 'string' },
    }, required: ['titulo', 'inicio'] },
  },
  agenda_alterar: {
    description: 'Muda título, horário ou local de um compromisso que já existe. Pegue o id com agenda_listar.',
    parameters: { type: 'object', properties: {
      id: { type: 'string' }, titulo: { type: 'string' }, inicio: { type: 'string' }, fim: { type: 'string' }, local: { type: 'string' },
    }, required: ['id'] },
  },
  agenda_apagar: {
    description: 'Apaga um compromisso. Só use se o usuário pediu claramente para apagar ou cancelar; se houver mais de um candidato, pergunte qual. Pegue o id com agenda_listar.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  tarefas_listar: {
    description: 'Lista as tarefas pendentes do Google Tarefas.',
    parameters: { type: 'object', properties: {} },
  },
  tarefas_criar: {
    description: 'Cria uma tarefa no Google Tarefas.',
    parameters: { type: 'object', properties: {
      titulo: { type: 'string' }, data: { type: 'string', description: 'Prazo opcional, só a data: 2026-10-10' },
    }, required: ['titulo'] },
  },
  tarefas_concluir: {
    description: 'Marca uma tarefa como concluída. Pegue o id com tarefas_listar.',
    parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
};

Object.assign(DEFS, {
  lembrete_criar: {
    description: 'Cria um lembrete ou timer que o Jarvis vai falar na hora certa. Use "em_minutos" para "daqui a 10 minutos" ou timers; use "quando" (ISO) para horários, ex.: "amanhã às 8h".',
    parameters: { type: 'object', properties: {
      texto: { type: 'string', description: 'Do que lembrar, curto. Em timer: o nome ("macarrão") ou "timer".' },
      em_minutos: { type: 'number', description: 'Daqui a quantos minutos.' },
      quando: { type: 'string', description: 'Data e hora ISO, ex.: 2026-10-05T08:00:00' },
    }, required: ['texto'] },
  },
  lembretes_listar: { description: 'Lista os lembretes e timers pendentes.', parameters: { type: 'object', properties: {} } },
  lembrete_cancelar: {
    description: 'Cancela um lembrete ou timer pendente, pelo id ou por um pedaço do texto.',
    parameters: { type: 'object', properties: { referencia: { type: 'string' } }, required: ['referencia'] },
  },
  memoria_guardar: {
    description: 'Guarda um fato sobre o usuário para lembrar em conversas futuras, quando ele pedir ("lembra que...", "anota que...") ou disser algo pessoal e duradouro (time, preferência, família). Não guarde senhas nem conversa passageira.',
    parameters: { type: 'object', properties: { fato: { type: 'string', description: 'O fato em uma frase curta, ex.: "O time do Axl é o Flamengo".' } }, required: ['fato'] },
  },
  memoria_esquecer: {
    description: 'Apaga um fato guardado, pelo id ou por um pedaço do texto, quando o usuário pedir para esquecer.',
    parameters: { type: 'object', properties: { referencia: { type: 'string' } }, required: ['referencia'] },
  },
  clima: {
    description: 'Previsão do tempo da cidade do usuário: agora e os próximos dias.',
    parameters: { type: 'object', properties: { dias: { type: 'number', description: 'De 1 a 7. Padrão 1 (hoje).' } } },
  },
  noticias: {
    description: 'Principais notícias de agora, no Brasil ou sobre um assunto.',
    parameters: { type: 'object', properties: { assunto: { type: 'string', description: 'Opcional, ex.: "tecnologia", "futebol".' } } },
  },
  windows_controlar: {
    description: 'Controla o computador: volume do Windows, mudo e bloquear a tela. Para música use as ferramentas do Spotify.',
    parameters: { type: 'object', properties: {
      acao: { type: 'string', enum: ['volume_mais', 'volume_menos', 'mudo', 'volume', 'bloquear_tela'] },
      valor: { type: 'number', description: 'Só para "volume": 0 a 100.' },
    }, required: ['acao'] },
  },
});

const WEATHER_PT = {
  0: 'céu limpo', 1: 'céu quase limpo', 2: 'parcialmente nublado', 3: 'nublado', 45: 'neblina', 48: 'neblina',
  51: 'garoa fraca', 53: 'garoa', 55: 'garoa forte', 56: 'garoa congelante', 57: 'garoa congelante',
  61: 'chuva fraca', 63: 'chuva', 65: 'chuva forte', 66: 'chuva congelante', 67: 'chuva congelante',
  71: 'neve fraca', 73: 'neve', 75: 'neve forte', 77: 'grãos de neve', 80: 'pancadas de chuva fracas',
  81: 'pancadas de chuva', 82: 'pancadas de chuva fortes', 85: 'pancadas de neve', 86: 'pancadas de neve fortes',
  95: 'trovoadas', 96: 'trovoadas com granizo', 99: 'trovoadas com granizo forte',
};
const LOCAL_TOOLS = ['lembrete_criar', 'lembretes_listar', 'lembrete_cancelar', 'memoria_guardar', 'memoria_esquecer', 'clima', 'windows_controlar'];
const CALENDAR_TOOLS = ['agenda_listar', 'agenda_criar', 'agenda_alterar', 'agenda_apagar', 'tarefas_listar', 'tarefas_criar', 'tarefas_concluir'];

/**
 * `google`, `web` e `spotify` são injetados (e simulados nos testes).
 * `isGoogleConnected()` e `settings()` são lidos a cada pergunta, para refletir o que mudou nos Ajustes.
 */
function createTools({ google, web, spotify, isGoogleConnected, isSpotifyConnected, settings, log, reminders, memory, apps, windows, weather, openers }) {
  const handlers = {
    async pesquisar_na_internet({ consulta }, ctx) {
      const q = str(consulta).trim().slice(0, 300);
      if (!q) return 'Faltou dizer o que pesquisar.';
      return web(q, ctx);
    },
    async agenda_listar({ inicio, fim }) {
      const events = await google.listEvents({ timeMin: str(inicio), timeMax: str(fim), max: 20 });
      if (!events.length) return 'Nenhum compromisso nesse período.';
      return `${events.length} compromisso(s):\n${events.map(describeEvent).join('\n')}`;
    },
    async agenda_criar({ titulo, inicio, fim, dia_inteiro, local }) {
      const e = await google.createEvent({ title: str(titulo), start: str(inicio), end: fim ? str(fim) : undefined, allDay: bool(dia_inteiro), location: local ? str(local) : undefined });
      return `Compromisso criado: ${describeEvent(e)}`;
    },
    async agenda_alterar({ id, titulo, inicio, fim, local }) {
      const e = await google.updateEvent(str(id), { title: titulo ? str(titulo) : undefined, start: inicio ? str(inicio) : undefined, end: fim ? str(fim) : undefined, location: local !== undefined ? str(local) : undefined });
      return `Compromisso atualizado: ${describeEvent(e)}`;
    },
    async agenda_apagar({ id }) {
      await google.deleteEvent(str(id));
      return 'Compromisso apagado.';
    },
    async tarefas_listar() {
      const tasks = await google.listTasks({ max: 30 });
      if (!tasks.length) return 'Nenhuma tarefa pendente.';
      return `${tasks.length} tarefa(s) pendente(s):\n${tasks.map((t) => `id=${t.id} | ${t.title}${t.due ? ` | prazo: ${when(t.due, true)}` : ''}`).join('\n')}`;
    },
    async tarefas_criar({ titulo, data }) {
      const t = await google.createTask({ title: str(titulo), due: data ? str(data) : undefined });
      return `Tarefa criada: ${t.title}${t.due ? ` (prazo ${when(t.due, true)})` : ''}.`;
    },
    async tarefas_concluir({ id }) {
      await google.completeTask(str(id));
      return 'Tarefa marcada como concluída.';
    },
  };
  if (spotify) Object.assign(handlers, spotify.handlers);

  const wlabel = (c) => WEATHER_PT[c] ?? 'tempo instável';
  const deg = (n) => `${Math.round(n)} graus`;
  const dayName = (iso, i) => (i === 0 ? 'hoje' : i === 1 ? 'amanhã' : new Intl.DateTimeFormat('pt-BR', { weekday: 'long' }).format(new Date(`${iso}T12:00:00`)));
  const hhmm = (ms) => `${dateFmt.format(new Date(ms))}, ${timeFmt.format(new Date(ms))}`;

  Object.assign(handlers, {
    async lembrete_criar({ texto, em_minutos, quando }) {
      const kind = /timer|cronometro|cronômetro/i.test(str(texto)) || (em_minutos && !quando && str(texto).length < 20) ? 'timer' : 'lembrete';
      let r;
      if (em_minutos != null && em_minutos !== '') r = reminders.addIn(Number(em_minutos), str(texto), kind);
      else {
        const at = Date.parse(str(quando));
        r = reminders.add({ text: str(texto), at, kind });
      }
      return `${kind === 'timer' ? 'Timer' : 'Lembrete'} criado para ${hhmm(r.at)}: ${r.text} (id=${r.id}).`;
    },
    async lembretes_listar() {
      const l = reminders.list();
      return l.length ? `${l.length} pendente(s):\n${l.map((r) => `id=${r.id} | ${r.text} | ${hhmm(r.at)}`).join('\n')}` : 'Nenhum lembrete pendente.';
    },
    async lembrete_cancelar({ referencia }) {
      const g = reminders.cancel(str(referencia));
      return g ? `Cancelei: ${g.text}.` : 'Não achei esse lembrete.';
    },
    async memoria_guardar({ fato }) {
      const f = memory.add(str(fato));
      return f.duplicate ? 'Isso eu já sabia.' : `Guardado: ${f.text}`;
    },
    async memoria_esquecer({ referencia }) {
      const g = memory.remove(str(referencia));
      return g ? `Esqueci: ${g.text}` : 'Não achei isso na memória.';
    },
    async clima({ dias }) {
      const city = settings().city;
      const f = await weather(city.lat, city.lon, Number(dias) || 1);
      const now = f.current ? `Agora em ${city.name}: ${deg(f.current.temperature_2m)}, ${wlabel(f.current.weather_code)}.` : '';
      const days = f.days.map((d, i) => `${dayName(d.date, i)}: ${wlabel(d.code)}, mínima ${deg(d.min)}, máxima ${deg(d.max)}, chuva ${Math.round(d.rain ?? 0)}%`).join('\n');
      return `${now}\n${days}`.trim();
    },
    async noticias({ assunto }, ctx) {
      const q = str(assunto).trim().slice(0, 100);
      return web(q ? `principais notícias de hoje sobre ${q}, resumo curto em português` : 'principais notícias de hoje no Brasil, resumo curto em português', ctx);
    },
    async abrir_programa({ nome }) {
      const opened = await apps.open(str(nome), settings().apps, openers);
      return `Abri ${opened}.`;
    },
    async windows_controlar({ acao, valor }) {
      return windows.control(str(acao), valor);
    },
  });

  // ferramentas locais só existem se o módulo correspondente foi entregue
  const deps = {
    lembrete_criar: reminders, lembretes_listar: reminders, lembrete_cancelar: reminders,
    memoria_guardar: memory, memoria_esquecer: memory, clima: weather,
    windows_controlar: windows && process.platform === 'win32' ? windows : null,
  };
  if (windows && windows.forceAvailable) deps.windows_controlar = windows;

  return {
    /** Ferramentas disponíveis agora (só as que estão conectadas e ligadas). */
    definitions() {
      const names = [];
      if (settings().webSearch && web) names.push('pesquisar_na_internet', 'noticias');
      for (const n of LOCAL_TOOLS) if (handlers[n] && deps[n]) names.push(n);
      if (isGoogleConnected()) names.push(...CALENDAR_TOOLS);
      if (spotify && isSpotifyConnected?.()) names.push(...Object.keys(spotify.definitions));
      const all = { ...DEFS, ...(spotify?.definitions ?? {}) };
      const out = names.map((name) => ({ type: 'function', function: { name, description: all[name].description, parameters: all[name].parameters } }));
      if (apps && openers) {
        const list = apps.entries(settings().apps).map((e) => e.name);
        out.push({ type: 'function', function: {
          name: 'abrir_programa',
          description: 'Abre um programa do computador da lista permitida.',
          parameters: { type: 'object', properties: { nome: { type: 'string', enum: list } }, required: ['nome'] },
        } });
      }
      return out;
    },

    /** Executa uma ferramenta. Sempre devolve texto. */
    async run(name, args, ctx = {}) {
      const fn = handlers[name];
      if (!fn) return `A ferramenta ${name} não existe.`;
      const t0 = Date.now();
      const brief = (v) => String(v).replace(/\s+/g, ' ').slice(0, 220);
      try {
        const out = await fn(args && typeof args === 'object' ? args : {}, ctx);
        log?.('ferramenta', `${name} ${brief(JSON.stringify(args))} -> ${brief(out)} (${Date.now() - t0} ms)`);
        return out;
      } catch (e) {
        log?.('ferramenta', `${name} ${brief(JSON.stringify(args))} FALHOU: ${brief(e.message)} (${Date.now() - t0} ms)`);
        return `Não deu certo: ${e.message}`;
      }
    },

    /** Fatos guardados, para o prompt do modelo. */
    memoryBlock: (userName) => memory?.promptBlock(userName) ?? '',

    /** Quais capacidades existem agora, para o prompt do modelo. */
    capabilities() {
      const c = [];
      if (settings().webSearch && web) c.push('pesquisar na internet');
      if (isGoogleConnected()) c.push('ver, criar, mudar e apagar compromissos do Google Agenda e cuidar das tarefas do Google Tarefas');
      if (spotify && isSpotifyConnected?.()) c.push('controlar o Spotify do computador (tocar, pausar, pular, volume)');
      if (reminders) c.push('criar lembretes e timers e falar na hora certa');
      if (memory) c.push('guardar fatos sobre o usuário para lembrar depois e esquecer quando ele pedir');
      if (weather) c.push('dizer a previsão do tempo');
      if (apps && openers) c.push('abrir programas do computador da lista permitida');
      if (deps.windows_controlar) c.push('mudar o volume do Windows, deixar mudo e bloquear a tela');
      return c;
    },
  };
}

module.exports = { createTools, describeEvent, when, DEFS };
