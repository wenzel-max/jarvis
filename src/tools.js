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

const CALENDAR_TOOLS = ['agenda_listar', 'agenda_criar', 'agenda_alterar', 'agenda_apagar', 'tarefas_listar', 'tarefas_criar', 'tarefas_concluir'];

/**
 * `google`, `web` e `spotify` são injetados (e simulados nos testes).
 * `isGoogleConnected()` e `settings()` são lidos a cada pergunta, para refletir o que mudou nos Ajustes.
 */
function createTools({ google, web, spotify, isGoogleConnected, isSpotifyConnected, settings, log }) {
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

  return {
    /** Ferramentas disponíveis agora (só as que estão conectadas e ligadas). */
    definitions() {
      const names = [];
      if (settings().webSearch && web) names.push('pesquisar_na_internet');
      if (isGoogleConnected()) names.push(...CALENDAR_TOOLS);
      if (spotify && isSpotifyConnected?.()) names.push(...Object.keys(spotify.definitions));
      const all = { ...DEFS, ...(spotify?.definitions ?? {}) };
      return names.map((name) => ({ type: 'function', function: { name, description: all[name].description, parameters: all[name].parameters } }));
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

    /** Quais capacidades existem agora, para o prompt do modelo. */
    capabilities() {
      const c = [];
      if (settings().webSearch && web) c.push('pesquisar na internet');
      if (isGoogleConnected()) c.push('ver, criar, mudar e apagar compromissos do Google Agenda e cuidar das tarefas do Google Tarefas');
      if (spotify && isSpotifyConnected?.()) c.push('controlar o Spotify do computador (tocar, pausar, pular, volume)');
      return c;
    },
  };
}

module.exports = { createTools, describeEvent, when, DEFS };
