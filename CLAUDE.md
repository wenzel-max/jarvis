# Jarvis

Assistente pessoal de desktop para Windows, feito por Axl (dev full-stack, trabalha em português). Abre sozinho ao ligar o PC, mostra uma esfera dourada animada (referência: interface do Jarvis dos filmes), hora, clima, notícias, e fala um resumo do dia em voz natural.

**Regra de ouro do projeto: tudo gratuito, sem chave paga.** Qualquer nova dependência ou serviço precisa ter plano gratuito utilizável.

Idioma: interface, textos, comentários e commits em **português do Brasil**. Código (nomes de variáveis/funções) em inglês ou português, seguindo o que já existe no arquivo.

## Hardware alvo (restringe decisões)

Acer Aspire A315-510P: Intel Core i3-N305, **8 GB de RAM** (7,68 utilizáveis), vídeo integrado Intel UHD, Windows 64 bits. Consequências:

- IA local pesada está descartada (modelo 7B não cabe). Para IA, usar API gratuita como principal e, no máximo, um modelo minúsculo (1B a 3B) via Ollama como reserva offline.
- Animação leve: esfera em shader, ~9 mil partículas, 30 fps em repouso e 60 fps só quando fala/pensa/ouve.
- Evitar `backdrop-filter`, blur pesado e qualquer coisa que force a GPU integrada.
- O app abre no boot: o atraso de 20 s (`startDelaySec`) existe de propósito.

## Stack

| Parte | Tecnologia |
|---|---|
| Shell | Electron `^44.5.1` (processo principal em CommonJS, renderer em ES modules) |
| Esfera | Three.js r186, **embutido** em `renderer/vendor/` (sem CDN, funciona offline) |
| Voz (saída) | `edge-tts-universal ^1.4.0`, no processo principal (Node). Cache MP3 em disco |
| Clima | Open-Meteo (forecast + geocoding), sem chave |
| Notícias | RSS buscado no processo principal, parser próprio sem dependência |
| Fontes | Saira e Saira Condensed (SIL OFL), embutidas em `renderer/vendor/fonts/` |
| Instalador | electron-builder (NSIS, instalação por usuário) |

Não há bundler, framework de UI nem TypeScript. É JavaScript puro; manter assim, a menos que o Axl peça.

## Estrutura

```
main.js           janela, autostart (setLoginItemSettings), IPC, instância única
preload.js        contextBridge: expõe window.jarvis ao renderer
src/settings.js   configurações persistidas (settings.json em userData) com validação
src/tts.js        síntese edge-tts, cache em disco, timeout, lista de vozes pt-BR
src/feeds.js      clima, busca de cidade, notícias RSS (decodifica ISO-8859-1)
src/ai.js         perguntas à IA (Groq, streaming), chave cifrada com safeStorage, divisão em frases
scripts/          test-ai.js (servidor falso, sem rede) e harness-ia.js (Electron + IPC simulado + capturas)
renderer/
  mic.js          microfone: grava com detecção de silêncio, mede o volume, mensagens de erro de permissão
  index.html      estrutura + CSP + drawer de Ajustes
  styles.css      tokens, layout em grid, drawer
  app.js          orquestração: estados, relógio, clima, notícias, resumo, Ajustes
  orb.js          a esfera (Three.js + shaders GLSL)
  voice.js        reprodução de áudio, medição de volume, reserva em speechSynthesis
  format.js       textos em pt-BR, frases do resumo falado, mapa de códigos do clima
  vendor/         three.module.js, three.core.js, fontes
```

## Comandos

```bash
npm install
npm start          # roda em desenvolvimento
npm run dist       # gera dist/Jarvis Setup x.y.z.exe
```

Atalhos no app: F11 tela cheia, Esc fecha Ajustes ou sai da tela cheia, Ctrl+, abre Ajustes, Ctrl+K foca a caixa de pergunta, Ctrl+M liga/desliga a escuta (Esc cancela).

Testes: `node scripts/test-ai.js` (sem rede) e `xvfb-run -a npx electron --no-sandbox scripts/harness-ia.js` (Linux; salva capturas em `scripts/out/`, ignorado pelo git).

## Arquitetura e decisões que não devem ser desfeitas sem motivo

**Segurança do Electron.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. O renderer só fala com o sistema pelo `window.jarvis` do preload. CSP restritiva no `index.html` (`default-src 'none'`, `connect-src 'none'`): **o renderer não faz requisições de rede**. Toda rede passa pelo processo principal (`src/feeds.js`, `src/tts.js`). `will-navigate` e `window.open` são bloqueados; `shell:open` só aceita `http(s)://`.

**Texto externo nunca entra por `innerHTML`.** Manchetes e nomes de cidade vêm de fora; o renderer usa o helper `el()` com `textContent`. Manter.

**Settings validados no processo principal** (`sanitize` em `src/settings.js`): faixas limitadas, voz validada por regex, só URLs `http(s)` nos feeds, cidade com coordenadas válidas. Todo campo novo precisa entrar no `DEFAULTS` e no `sanitize`.

**IPC (canais atuais):** `settings:get`, `settings:set`, `tts:voices`, `tts:synthesize`, `weather:get`, `geo:search`, `news:get`, `shell:open`, `win:fullscreen`, `app:quit`, `ai:ask` (+ evento `ai:sentence` main→renderer), `ai:cancel`, `ai:key-status`, `ai:key-set`, `stt:transcribe`. Novo canal = handler em `main.js` + método no `preload.js`.

**Por que a voz roda no processo principal.** Desde a v1.4.0 o edge-tts exige um header de WebSocket que navegadores não permitem. Só Node funciona. O main devolve um `Buffer` MP3 por IPC e o renderer toca num `<audio>`.

**Voz: robustez offline.**
- A síntese tem **timeout de 6 s** (`SYNTH_TIMEOUT_MS`); a biblioteca não tem prazo próprio e travaria sem internet.
- Após a primeira falha numa sequência, as frases seguintes usam `cacheOnly` (só o cache em disco, resposta imediata) e o resto cai em `speechSynthesis` (voz do Windows).
- `_speakSystem` tem limite de tempo porque alguns motores nunca disparam `end`.
- Cache: SHA-1 de texto+voz+velocidade+tom, máximo de 300 arquivos (os mais antigos saem).

**Frases com texto exibido diferente do falado.** Em `buildBriefing`, a primeira frase é `{ show, say }` para suportar `userNameSpoken` (pronúncia alternativa do nome). `speakSequence` aceita string ou `{show, say}`.

**Esfera (`orb.js`).** Três camadas aditivas sobre fundo sólido `#090604`: núcleo de partículas (rotação diferencial por latitude, o que dá o efeito de redemoinho sem tirar pontos da esfera), traços de circuito (`LineSegments` que andam na superfície com curvas de 90°) e 8 anéis de "cometas" (shader com cabeça e cauda). Uniformes compartilhados entre materiais. Estados em `STATES` (`idle`, `listening`, `thinking`, `speaking`) são interpolados suavemente; `setState(nome)` e `setLevel(0..1)` são a API pública. Os anéis são definidos por vetor normal com `|nz| >= 0.4`, **de propósito**: um anel visto de perfil vira um traço reto feio. Pixel ratio limitado a 1.5. Em janelas ≤ 980 px a esfera encolhe e sobe.

**Estados da interface (`app.js`).** `hud.dataset.state` = `idle | listening | thinking | speaking`; `setState()` atualiza o atributo, a esfera e o texto de status. `speakId` é um contador para que uma fala antiga que termina não reponha o estado de uma fala nova. `loop(nome, fn, okMs, failMs)` agenda atualizações periódicas (clima 15 min, notícias 20 min, retry em 2 min).

**Autostart.** `app.setLoginItemSettings` com `--autostart`. Em desenvolvimento passa também o caminho do app. Ao abrir com `--autostart`, espera `startDelaySec` antes de criar a janela. Autoplay de áudio liberado (`autoplayPolicy: 'no-user-gesture-required'`), necessário para falar na abertura.

## Design

Direção: HUD âmbar sobre o vazio. **A esfera é o único elemento ousado**; o resto é discreto: sem cartões, sem caixas, texto direto sobre o fundo, um filete de luz vertical marcando cada coluna.

Tokens (em `styles.css`): `--void #090604`, `--ember #ff9a1f`, `--gold #ffd27a`, `--copper #a8501c`, `--ink #f3e8d2`, `--dim #a09076`.
Tipografia: Saira Condensed 200/300 só nos números grandes (hora, temperatura); Saira 300/400/500 no resto.

Regras de estilo a manter: rótulos em caixa normal (sem CAIXA ALTA), sem numeração decorativa, sem "→" em botões, sem animações espalhadas (a única animação autônoma é a esfera montando e o texto entrando uma vez), `prefers-reduced-motion` respeitado, foco visível. Textos de erro explicam o que houve e o que fazer, sem pedir desculpas.

## O que foi testado e o que NÃO foi

Testado (Electron 44 em Linux com display virtual, harness com IPC simulado e `capturePage`): renderização WebGL, os 4 estados da esfera, layout em 1366×768, 1920×1080 e 900×700, Ajustes, mensagens de erro offline, fluxo do resumo com a voz online indisponível (timeout e reserva), validação e persistência de settings, parser de RSS.

**Nunca testado em Windows real, trate como suspeito:**
1. Síntese real do edge-tts (o ambiente de teste bloqueava a rede). Confirmar que `listVoices()` e `EdgeTTS.synthesize()` funcionam e que as vozes pt-BR esperadas existem (`pt-BR-AntonioNeural`, `pt-BR-FranciscaNeural`, `pt-BR-ThalitaMultilingualNeural`).
2. Autostart no login do Windows e o atraso de 20 s.
3. `npm run dist` e o instalador NSIS.
4. As URLs padrão dos feeds (G1, Folha, Tecnoblog) foram escritas de memória e nunca abertas.
5. `speechSynthesis` com voz pt-BR do Windows como reserva.
6. Desempenho real na GPU integrada (o teste usou renderização por software).
7. Como a voz pronuncia "Axl" (campo `userNameSpoken` existe para corrigir).
8. Chamada real ao Groq (só testada contra servidor falso), `safeStorage` no Windows e o ID do modelo padrão.
9. Microfone real no Windows: permissão de privacidade, qualidade da gravação, limiar de silêncio e `multipart` contra o Whisper de verdade. O harness usa o microfone falso do Chromium (bipes).

Para testar a interface sem rede, o padrão que funcionou foi um script Electron separado que registra handlers `ipcMain` falsos (clima/notícias simulados), carrega `renderer/index.html` com o `preload.js` real e usa `webContents.capturePage()` para gerar imagens. Vale recriar isso em `scripts/` se for mexer em visual.

## Configurações (`settings.json`, em `%APPDATA%\jarvis`)

`userName`, `userNameSpoken`, `voice`, `rate` (-50..50 %), `pitch` (-30..30 Hz), `city {name, admin, lat, lon}` (padrão Ceará-Mirim, RN), `autostart`, `startDelaySec` (0..180), `speakOnStart`, `fullscreen`, `feeds [{name, url}]`, `aiModel`, `sttModel`, `micLabel`.

## Roadmap

**Fase 2: agenda e tarefas do dia (Google).** Google Calendar API e Google Tasks API (cota gratuita sobra para uso pessoal). Fluxo OAuth para app desktop: navegador do sistema + redirecionamento em `127.0.0.1` com porta local + PKCE, escopos somente leitura. Guardar o refresh token com `safeStorage` do Electron, nunca em texto puro nem no `settings.json`. Todas as chamadas no processo principal (a CSP do renderer continua `connect-src 'none'`). Novos widgets na coluna esquerda e frases novas em `buildBriefing` ("Você tem 2 compromissos hoje..."). Conta Google do Axl: wenzelaxl5@gmail.com.

**Fase 3: perguntas e respostas com IA (FEITA, falta testar em Windows real).** Groq (`llama-3.1-8b-instant` por padrão, editável em Ajustes), chave cifrada em `ai-key.bin` com `safeStorage` (nunca vai ao renderer nem ao `settings.json`). A resposta chega em streaming, `src/ai.js` corta em frases e o renderer as empurra numa fila assíncrona que `Voice.speakSequence` consome (aceita lista ou iterável assíncrono). Histórico das últimas 8 mensagens fica só no renderer, validado no main. Limites gratuitos conferidos por busca (30 req/min; 8b: ~14,4 mil req e 500 mil tokens/dia; 70b: 1 mil req e 100 mil tokens/dia), mas a página oficial estava bloqueada no ambiente: confirmar em console.groq.com/docs/rate-limits. Se o Groq recusar o modelo (ID renomeado/aposentado), `ai.ask` consulta `/models` da conta, escolhe outro (`PREFERRED`), tenta de novo e o `main.js` grava o que funcionou em `aiModel`. Pendente: reserva offline com Ollama (opcional). Texto original do plano: Caixa de texto + resposta falada, estados `thinking` e `speaking` da esfera já prontos. API gratuita (Gemini ou Groq) como principal, com a chave guardada via `safeStorage`; reserva opcional em Ollama com modelo pequeno. Os limites gratuitos mudam, confirmar na documentação oficial antes de implementar. Streaming de resposta falando frase a frase (reaproveitar `speakSequence`).

**Fase 4: voz de entrada (FEITA, falta testar em Windows real).** Escolhido o Whisper do Groq (mesma chave da Fase 3; limites gratuitos por busca: 20 req/min, 2 mil req/dia, 7.200 s de áudio/hora). `renderer/mic.js` grava (MediaRecorder, webm/opus, 32 kbps) e para sozinho após 1,3 s de silêncio, com limiar adaptativo ao ruído do ambiente (máx. 15 s, desiste após 7 s sem fala); o áudio vai por `stt:transcribe` ao main, que envia `multipart` ao Groq (`language=pt`) e devolve o texto, que segue o fluxo normal de `ask()`. Estado `listening` da esfera pulsa com o volume do microfone. O main só concede permissão de microfone (áudio, sem vídeo) à página local `file://` (`allowMicrophoneOnly`). Modelo em `sttModel` (padrão `whisper-large-v3-turbo`) com troca automática por outro Whisper multilíngue da conta se for recusado (exclui `distil-*` e `-en`, que só falam inglês). Frases de alucinação do Whisper em silêncio ("Legendas pela comunidade Amara.org") são descartadas. O microfone tenta várias aberturas (`Mic._open`: filtros, cru, mono, cada dispositivo) porque o driver Intel Smart Sound "Grupo de microfones" do Chromium dá `NotReadableError` no padrão. O "dispositivo padrão" do Chromium pode ser um microfone VIRTUAL mudo (ex.: Steam Streaming Microphone abre sem erro e só entrega silêncio), então `_open` ordena os candidatos (escolhido em `micLabel` > reais > atalhos do sistema > virtuais, regex `VIRTUAL`), testa cada um com várias configurações e guarda `mic.report` (o que cada dispositivo respondeu), que entra nas mensagens de erro. Ajustes tem seletor de microfone. O limiar de voz usa o MENOR volume dos primeiros 350 ms (teto 0,035), para não ignorar quem já começa falando ao clicar. `Mic.stats` (dispositivo, pico, ms de fala) alimenta `explainNoSpeech` e o botão Testar microfone nos Ajustes. Sem palavra de ativação: o clique em Falar ou Ctrl+M inicia. Ideia futura: palavra de ativação (exigiria ouvir o tempo todo, pesado para o i3).

## Como trabalhar neste projeto

- Mudanças pequenas e focadas; explicar o que mudou e por quê, em português.
- Antes de afirmar que algo funciona, rodar (`npm start`) ou testar com o padrão do harness. Se não deu para testar, dizer.
- Não adicionar dependência sem necessidade; o app precisa continuar leve e instalável sem build complexo.
- Não quebrar a regra "o renderer não faz rede".
- Ao mexer na esfera, olhar uma captura de tela; é visual, não dá para validar só lendo o código.
