# Jarvis

Assistente pessoal de desktop para Windows, feito por Axl (dev full-stack, trabalha em português). Abre sozinho ao ligar o PC, mostra uma esfera dourada animada (referência: interface do Jarvis dos filmes), hora, clima, agenda, e fala um resumo do dia em voz natural.

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
| Fontes | Saira e Saira Condensed (SIL OFL), embutidas em `renderer/vendor/fonts/` |
| Instalador | electron-builder (NSIS, instalação por usuário) |

Não há bundler, framework de UI nem TypeScript. É JavaScript puro; manter assim, a menos que o Axl peça.

## Estrutura

```
main.js           janela, autostart (setLoginItemSettings), IPC, instância única
preload.js        contextBridge: expõe window.jarvis ao renderer
src/settings.js   configurações persistidas (settings.json em userData) com validação
src/tts.js        síntese edge-tts, cache em disco, timeout, lista de vozes pt-BR
src/feeds.js      clima e busca de cidade (Open-Meteo)
src/compat.js     modo de compatibilidade do microfone (desliga o sandbox de áudio do Chromium)
src/ai.js         perguntas à IA (Groq, streaming), ciclo de ferramentas, busca na internet (Compound), chave cifrada, divisão em frases
src/tools.js      ferramentas da IA (agenda, tarefas, busca, Spotify): definições, execução e resultados em texto
src/spotify.js    Spotify: login PKCE, busca, tocar, pausar, pular, volume, o que está tocando, e as 2 ferramentas da IA
src/google.js     Google Agenda e Tarefas: login, renovação do token, eventos e tarefas
src/oauth.js      login OAuth de desktop (navegador do sistema + retorno em 127.0.0.1 + PKCE), serve ao Google e ao Spotify
src/secrets.js    cofre de segredos cifrado com safeStorage (tokens e credenciais), um arquivo .bin por item
scripts/          test-ai.js, test-google.js (Google falso), test-spotify.js (Spotify falso), test-tools.js (Groq falso com ferramentas), test-wake.mjs (palavra de ativação), harness-ia.js (Electron + IPC simulado + microfone sintético + capturas)
renderer/
  mic.js          microfone sempre aberto: segmenta frases por silêncio (pré-roll 400 ms), entrega WAV 16 kHz, escolhe o dispositivo, mensagens de erro
  wake.js         palavra de ativação "Jarvis" (variações do Whisper: Jarves, Garvis...) no começo ou no fim da frase; frases curtas ("para", "obrigado"); comandos de música ("pausa", "próxima", "volume 40")
  index.html      estrutura + CSP + drawer de Ajustes
  styles.css      tokens, layout em grid, drawer
  app.js          orquestração: estados, relógio, clima, agenda, resumo, Ajustes
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

Atalhos no app: F11 tela cheia, Esc fecha Ajustes ou sai da tela cheia, Ctrl+, abre Ajustes, Ctrl+M liga/desliga a escuta (não existe mais caixa de digitar nem legenda: o Jarvis é só por voz), Esc fecha Ajustes ou para a fala.

Testes: `node scripts/test-ai.js`, `test-google.js`, `test-spotify.js`, `test-tools.js` e `node scripts/test-wake.mjs` (sem rede) e `xvfb-run -a npx electron --no-sandbox scripts/harness-ia.js` (Linux; salva capturas em `scripts/out/`, ignorado pelo git).

## Arquitetura e decisões que não devem ser desfeitas sem motivo

**Segurança do Electron.** `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`. O renderer só fala com o sistema pelo `window.jarvis` do preload. CSP restritiva no `index.html` (`default-src 'none'`, `connect-src 'none'`): **o renderer não faz requisições de rede**. Toda rede passa pelo processo principal (`src/feeds.js`, `src/tts.js`). `will-navigate` e `window.open` são bloqueados; `shell:open` só aceita `http(s)://`.

**Texto externo nunca entra por `innerHTML`.** Nomes de cidade e títulos de compromisso vêm de fora; o renderer usa o helper `el()` com `textContent`. Manter.

**Settings validados no processo principal** (`sanitize` em `src/settings.js`): faixas limitadas, voz validada por regex, só URLs `http(s)` nos feeds, cidade com coordenadas válidas. Todo campo novo precisa entrar no `DEFAULTS` e no `sanitize`.

**IPC (canais atuais):** `settings:get`, `settings:set`, `tts:voices`, `tts:synthesize`, `weather:get`, `geo:search`, `shell:open`, `win:fullscreen`, `app:quit`, `ai:ask` (+ evento `ai:sentence` main→renderer), `ai:cancel`, `ai:key-status`, `ai:key-set`, `stt:transcribe`, `google:status`, `google:connect`, `google:disconnect`, `agenda:today`, `spotify:status`, `spotify:connect`, `spotify:disconnect`, `media:control`. Novo canal = handler em `main.js` + método no `preload.js`.

**Por que a voz roda no processo principal.** Desde a v1.4.0 o edge-tts exige um header de WebSocket que navegadores não permitem. Só Node funciona. O main devolve um `Buffer` MP3 por IPC e o renderer toca num `<audio>`.

**Voz: robustez offline.**
- A síntese tem **timeout de 6 s** (`SYNTH_TIMEOUT_MS`); a biblioteca não tem prazo próprio e travaria sem internet.
- Após a primeira falha numa sequência, as frases seguintes usam `cacheOnly` (só o cache em disco, resposta imediata) e o resto cai em `speechSynthesis` (voz do Windows).
- `_speakSystem` tem limite de tempo porque alguns motores nunca disparam `end`.
- Cache: SHA-1 de texto+voz+velocidade+tom, máximo de 300 arquivos (os mais antigos saem).

**Frases com texto exibido diferente do falado.** Em `buildBriefing`, a primeira frase é `{ show, say }` para suportar `userNameSpoken` (pronúncia alternativa do nome). `speakSequence` aceita string ou `{show, say}`.

**Sem notícias.** O Axl pediu para tirar a aba de notícias: não há mais feeds RSS, nem `news:get`, nem seção nos Ajustes, nem manchetes no resumo falado. `sanitize` apaga `feeds` de `settings.json` antigos. A coluna da direita agora é a agenda e as tarefas (`#agenda`), com uma dica para conectar o Google quando não está conectado. A busca na internet da IA continua existindo (outra coisa).

**Sem legendas.** O Jarvis não mostra o que fala nem o que ouviu (pedido do Axl). `#notice` existe só para avisos e erros, discreto e some sozinho (`showNotice`). Os testes verificam o que ele fala pelas chamadas a `tts:synthesize`, não por texto na tela.

**Voz natural e sem buracos (`voice.js`).** Web Audio, não `<audio>`: cada frase é decodificada e agendada colada na anterior, com 0,12 s de respiração (`BREATH_S`); duas frases ficam sintetizadas à frente (`LOOKAHEAD`); `stop()` corta tudo na hora (3 ms). A voz do sistema (reserva) não se agenda: espera o que já foi agendado. O texto também importa: o prompt de `src/ai.js` pede fala coloquial brasileira ("tá", "pra"), frases curtas e uma a três frases, e o `Sentencer` solta a PRIMEIRA frase mais cedo (14 caracteres, ou até uma vírgula com 30) porque é ela que decide quando o Jarvis começa a falar.

**Interrupção (barge-in).** O microfone NÃO fica mudo quando o Jarvis fala: em `thinking`/`speaking` o `Mic` entra em modo `duck` (limiar = max(2×normal, 0,03) e 6 blocos seguidos, ~250 ms) e, ao detectar fala firme, dispara `onBargeIn` → `interrupt()` em `app.js` (corta voz e IA, abre a janela de conversa, passa a ouvir). O trecho interrompido segue como pergunta sem exigir "Jarvis". "Para", "chega" etc. calam sem chamar a IA e "obrigado" responde "De nada!" local (`classifyShort`). Uma pausa no meio da frase (>0,6 a 0,85 s) gera dois trechos: o segundo fica em `pendingSeg` e é juntado ao primeiro. Config `bargeIn` (padrão ligado): com caixas de som o eco pode se auto-interromper, então o aviso nos Ajustes diz para usar fone ou desligar. Dependemos do cancelamento de eco do Chromium (`echoCancellation`), não testado com caixas reais.

**Ferramentas da IA (`src/tools.js` + `ask` em `src/ai.js`).** `ask` é um ciclo: o modelo responde em streaming e, se pedir uma ferramenta (`tool_calls` chegam em pedaços, por índice), o main executa, devolve o resultado como texto (`role: tool`) e o modelo responde de novo (máx. 4 voltas, depois é forçado a responder). Sem ferramenta a resposta sai em streaming como sempre, sem atraso extra. Só vão ao modelo as ferramentas que estão disponíveis agora (`definitions()`: Google só se conectado, busca só se `webSearch`), e o prompt diz o que o Jarvis consegue fazer e a data/hora de agora em ISO para ele resolver "amanhã", "sexta". Uma frase dita antes da ferramenta ("Deixa eu ver.") é falada normalmente. Erros de ferramenta viram texto (`Não deu certo: ...`), nunca lançam. Se o modelo monta a chamada errada (`tool_use_failed`), repete sem ferramentas. Apagar/mudar compromisso exige `agenda_listar` antes (ids) e o prompt manda perguntar se houver dúvida.

**Google Agenda e Tarefas (`src/google.js`).** OAuth de app de desktop (Google aceita porta aleatória em 127.0.0.1; exige `client_secret` mesmo com PKCE; `access_type=offline&prompt=consent`). Escopos: `calendar.events` e `tasks`. Credenciais (ID e chave do cliente) e tokens ficam cifrados em `google.bin`, colados pelo Axl nos Ajustes (nunca voltam ao renderer). **Armadilha:** com o app em "Teste" no Google Cloud o refresh token expira em 7 dias. "Publicar app" exige a página de Identidade visual com links de página inicial e de política de privacidade (e a política do Google fala em verificar o domínio deles), então **a recomendação é ficar em Teste**, com o e-mail do Axl em "Usuários de teste", e reconectar a cada 7 dias. `invalid_grant` marca `needsReconnect`: o painel "Agenda" e o resumo falado avisam, e "Conectar de novo" nos Ajustes reaproveita o ID e a chave guardados (`google.connect()` sem argumentos), sem colar nada. O resumo falado recarrega a agenda antes de falar (`loadAgenda`), para não usar dados de até 10 minutos atrás. A agenda só olha o calendário principal. O painel "Hoje na agenda" (coluna esquerda) e o resumo falado usam `agenda:today`.

**Spotify (`src/spotify.js`).** Controla o app do Spotify do PC pela Web API (o Axl tem Premium e precisa deixar o app aberto). OAuth PKCE sem chave secreta, **porta fixa 8898** (`http://127.0.0.1:8898/callback` registrada no painel; o Spotify exige a porta idêntica). Regras de 2026 (por busca, a página oficial estava bloqueada): controlar a reprodução exige Premium e o app de desenvolvedor só funciona enquanto o dono tiver Premium; modo desenvolvimento = 1 app por desenvolvedor e até 5 usuários cadastrados (o e-mail do Axl precisa estar em User Management); busca limitada a 10 resultados (usamos 5). Dispositivo: o ativo, senão o tipo `Computer`, senão o primeiro; sem nenhum, a mensagem manda abrir o Spotify. Duas ferramentas da IA (`spotify_tocar`, `spotify_controlar`) e um caminho rápido **sem IA** (`classifyMedia` em `wake.js` + `media:control`): "pausa", "continua a música", "próxima", "anterior", "volume 40", "aumenta o volume", "que música é essa?". A música é o retorno, então esses comandos ficam em silêncio; só erro e "que música é essa" falam. "Para" sozinho continua sendo calar o Jarvis; "volta a música" é faixa anterior. Não implementado: baixar o volume da música enquanto o Jarvis fala (ducking), e com música nas caixas o microfone transcreve a letra (gasta cota do Whisper, limite local de 10/min).

**Busca na internet.** Ferramenta `pesquisar_na_internet` chama o modelo `groq/compound-mini` (busca embutida, mesma chave; limite gratuito por busca: 30 req/min e 250/dia, mas a página oficial estava bloqueada no ambiente: confirmar se o plano gratuito permite a ferramenta de busca, que é cobrada em planos pagos). Se o modelo não existir, descobre outro `compound` da conta e grava em `webModel`; se não houver, devolve que a busca não está disponível. Opção `webSearch` nos Ajustes.

**Núcleo da esfera (`orb.js`).** Como nos filmes, o centro tem um coração: ponto branco-quente com brilho, um anel fino ("olho") e clarão em cruz leve (`NUCLEUS_FRAG`), 90 raios que saem dele até a casca com pulsos de luz viajando (`SPOKE_*`, no grupo inclinado, giram ao contrário da casca), 3 anéis de giroscópio pequenos e inclinados (mesmo shader dos cometas, com `uBase` maior) e uma íris de HUD com círculos tracejados e régua que giram em sentidos opostos (`IRIS_FRAG`). Coração e íris são planos que sempre encaram a câmera, como o halo. Cada estado tem `core` em `STATES` (ouvindo cresce com a voz, pensando acelera tudo, falando pulsa com o áudio). O miolo esparso de partículas fica afastado do centro (r ≥ 0,3) para o núcleo aparecer limpo. **Para ver a esfera aqui:** `scripts/shot-orb.js` liga WebGL por software (SwiftShader) e salva `orb-<estado>.png` e um recorte ampliado `crop-<estado>.png`; leva alguns minutos por estado porque não há GPU. O harness principal NÃO renderiza WebGL (usa o anel de reserva).

**Esfera (`orb.js`).** Três camadas aditivas sobre fundo sólido `#090604`: núcleo de partículas (rotação diferencial por latitude, o que dá o efeito de redemoinho sem tirar pontos da esfera), traços de circuito (`LineSegments` que andam na superfície com curvas de 90°) e 8 anéis de "cometas" (shader com cabeça e cauda). Uniformes compartilhados entre materiais. Estados em `STATES` (`idle`, `listening`, `thinking`, `speaking`) são interpolados suavemente; `setState(nome)` e `setLevel(0..1)` são a API pública. Os anéis são definidos por vetor normal com `|nz| >= 0.4`, **de propósito**: um anel visto de perfil vira um traço reto feio. Pixel ratio limitado a 1.5. Em janelas ≤ 980 px a esfera encolhe e sobe.

**Estados da interface (`app.js`).** `hud.dataset.state` = `idle | listening | thinking | speaking`; `setState()` atualiza o atributo, a esfera e o texto de status. `speakId` é um contador para que uma fala antiga que termina não reponha o estado de uma fala nova. `loop(nome, fn, okMs, failMs)` agenda atualizações periódicas (clima 15 min, agenda 10 min, retry em 2 min).

**Autostart.** `app.setLoginItemSettings` com `--autostart`. Em desenvolvimento passa também o caminho do app. Ao abrir com `--autostart`, espera `startDelaySec` antes de criar a janela. Autoplay de áudio liberado (`autoplayPolicy: 'no-user-gesture-required'`), necessário para falar na abertura.

## Design

Direção: HUD âmbar sobre o vazio. **A esfera é o único elemento ousado**; o resto é discreto: sem cartões, sem caixas, texto direto sobre o fundo, um filete de luz vertical marcando cada coluna.

Tokens (em `styles.css`): `--void #090604`, `--ember #ff9a1f`, `--gold #ffd27a`, `--copper #a8501c`, `--ink #f3e8d2`, `--dim #a09076`.
Tipografia: Saira Condensed 200/300 só nos números grandes (hora, temperatura); Saira 300/400/500 no resto.

Regras de estilo a manter: rótulos em caixa normal (sem CAIXA ALTA), sem numeração decorativa, sem "→" em botões, sem animações espalhadas (a única animação autônoma é a esfera montando e o texto entrando uma vez), `prefers-reduced-motion` respeitado, foco visível. Textos de erro explicam o que houve e o que fazer, sem pedir desculpas.

## O que foi testado e o que NÃO foi

Testado (Electron 44 em Linux com display virtual, harness com IPC simulado e `capturePage`; WebGL só pelo `shot-orb.js`): renderização WebGL, os 4 estados da esfera, layout em 1366×768, 1920×1080 e 900×700, Ajustes, mensagens de erro offline, fluxo do resumo com a voz online indisponível (timeout e reserva), validação e persistência de settings, parser de RSS.

**Nunca testado em Windows real, trate como suspeito:**
1. Síntese real do edge-tts (o ambiente de teste bloqueava a rede). Confirmar que `listVoices()` e `EdgeTTS.synthesize()` funcionam e que as vozes pt-BR esperadas existem (`pt-BR-AntonioNeural`, `pt-BR-FranciscaNeural`, `pt-BR-ThalitaMultilingualNeural`).
2. Autostart no login do Windows e o atraso de 20 s.
3. `npm run dist` e o instalador NSIS.
5. `speechSynthesis` com voz pt-BR do Windows como reserva.
6. Desempenho real na GPU integrada (o teste usou renderização por software).
7. Como a voz pronuncia "Axl" (campo `userNameSpoken` existe para corrigir).
8. Chamada real ao Groq (só testada contra servidor falso), `safeStorage` no Windows e o ID do modelo padrão.
11. Login real do Spotify, endpoints de player no modo desenvolvimento de 2026 (assumidos, não conferidos) e o app aberto no PC.
10. Login real do Google (OAuth, publicar o app, aviso de não verificado), a Calendar API e a Tasks API de verdade, e a busca `groq/compound-mini` no plano gratuito.
9. Microfone real no Windows (o Intel Smart Sound do notebook do Axl falha no Chromium; `micCompat` é a aposta, ainda não confirmada): permissão de privacidade, qualidade da gravação, limiar de silêncio e `multipart` contra o Whisper de verdade. O harness usa o microfone falso do Chromium (bipes).

Para testar a interface sem rede, o padrão que funcionou foi um script Electron separado que registra handlers `ipcMain` falsos (clima/notícias simulados), carrega `renderer/index.html` com o `preload.js` real e usa `webContents.capturePage()` para gerar imagens. Vale recriar isso em `scripts/` se for mexer em visual.

## Configurações (`settings.json`, em `%APPDATA%\jarvis`)

`userName`, `userNameSpoken`, `voice`, `rate` (-50..50 %), `pitch` (-30..30 Hz), `city {name, admin, lat, lon}` (padrão Ceará-Mirim, RN), `autostart`, `startDelaySec` (0..180), `speakOnStart`, `fullscreen`, `aiModel`, `sttModel`, `webSearch`, `webModel`, `bargeIn`, `listenOnStart`, `micLabel`, `micCompat`.

## Roadmap

**Fase 2: agenda e tarefas do dia (Google) (FEITA, falta testar com a conta real).** Ver "Google Agenda e Tarefas" acima. Texto original do plano: Google Calendar API e Google Tasks API (cota gratuita sobra para uso pessoal). Fluxo OAuth para app desktop: navegador do sistema + redirecionamento em `127.0.0.1` com porta local + PKCE, escopos somente leitura. Guardar o refresh token com `safeStorage` do Electron, nunca em texto puro nem no `settings.json`. Todas as chamadas no processo principal (a CSP do renderer continua `connect-src 'none'`). Novos widgets na coluna esquerda e frases novas em `buildBriefing` ("Você tem 2 compromissos hoje..."). Conta Google do Axl: wenzelaxl5@gmail.com.

**Fase 3: perguntas e respostas com IA (FEITA, falta testar em Windows real).** Groq (`llama-3.1-8b-instant` por padrão, editável em Ajustes), chave cifrada em `ai-key.bin` com `safeStorage` (nunca vai ao renderer nem ao `settings.json`). A resposta chega em streaming, `src/ai.js` corta em frases e o renderer as empurra numa fila assíncrona que `Voice.speakSequence` consome (aceita lista ou iterável assíncrono). Histórico das últimas 8 mensagens fica só no renderer, validado no main. Limites gratuitos conferidos por busca (30 req/min; 8b: ~14,4 mil req e 500 mil tokens/dia; 70b: 1 mil req e 100 mil tokens/dia), mas a página oficial estava bloqueada no ambiente: confirmar em console.groq.com/docs/rate-limits. Se o Groq recusar o modelo (ID renomeado/aposentado), `ai.ask` consulta `/models` da conta, escolhe outro (`PREFERRED`), tenta de novo e o `main.js` grava o que funcionou em `aiModel`. Pendente: reserva offline com Ollama (opcional). Texto original do plano: Caixa de texto + resposta falada, estados `thinking` e `speaking` da esfera já prontos. API gratuita (Gemini ou Groq) como principal, com a chave guardada via `safeStorage`; reserva opcional em Ollama com modelo pequeno. Os limites gratuitos mudam, confirmar na documentação oficial antes de implementar. Streaming de resposta falando frase a frase (reaproveitar `speakSequence`).

**Fase 4: voz de entrada, mãos livres (FEITA, falta testar em Windows real).** Só por voz: sem caixa de digitar e sem apertar nada para falar. O microfone fica aberto (`Mic.start`, ScriptProcessor 2048 amostras; obsoleto mas funciona no Electron) e `_onBlock` segmenta sozinho: ruído de fundo = menor volume dos primeiros 500 ms e depois acompanhado enquanto ninguém fala; limiar = clamp(ruído×3,5; 0,008..0,04); começa com 2 blocos seguidos acima, guarda 400 ms de pré-roll para não cortar a primeira sílaba, termina com 0,85 s de silêncio se falou menos de 0,9 s ("Jarvis..." pode vir seguido de pausa) ou 0,6 s se falou mais (ou 20 s), e só 250 ms do silêncio final vão no WAV, descarta o que tiver menos de 350 ms de voz. Cada frase vai em **WAV 16 kHz mono** (`encodeWav`) por `stt:transcribe` ao main, que envia `multipart` ao Whisper do Groq (`language=pt`). Limites gratuitos por busca: 20 req/min, 2 mil req/dia, 7.200 s de áudio/hora (mín. 10 s cobrados por pedido); o app limita a 10 transcrições/min.

**Quando o Jarvis age** (`app.js`, `handleSegment`): só se a frase começar com "Jarvis" (`wake.js`), ou dentro da janela de conversa de 15 s (`FOLLOW_UP_MS`) aberta depois de cada resposta, "Pois não?" ou "não entendi". Conversa ao redor é transcrita e ignorada. Se não entender dentro da conversa, fala "Não entendi, pode repetir?" e continua ouvindo (até 2 vezes seguidas). Erros de configuração (chave, conexão, limite) aparecem na legenda no máximo 1 vez por minuto, sem falar. **Em `thinking`/`speaking` o microfone entra em `duck` e volta ao normal 700 ms depois de `idle`**, para o Jarvis não confundir a própria voz com a sua (ver Interrupção). Botão "Escuta ligada/desligada" na barra e Ctrl+M; `listenOnStart` (padrão ligado) abre o microfone ao iniciar. **Privacidade:** só trechos com fala vão ao Groq; o texto de Ajustes diz isso.

**Microfone no Windows do Axl:** o "Grupo de microfones" da Intel Smart Sound falha no Chromium (`Could not start audio source`); com fone funciona. `Mic._open` abre o padrão, ordena os candidatos (escolhido em `micLabel` > reais > atalhos > virtuais, regex `VIRTUAL`: o Steam Streaming Microphone abre mudo!), tenta várias configurações por dispositivo e guarda `mic.report` para as mensagens. `micCompat` (`src/compat.js`, `disable-features=AudioServiceSandbox`, exige reiniciar via `app:relaunch`) é a aposta para o Intel, ainda não confirmada. Plano B: fone ou microfone USB. O botão Testar microfone (Ajustes) mede o pico com `Mic.stats` e explica com `explainNoSpeech`.

Sem palavra de ativação local (Vosk/openWakeWord) por ora: a ativação depende da transcrição do Whisper; uma palavra local economizaria cota e não enviaria áudio ambiente, mas pesa no i3.

## Como trabalhar neste projeto

- Mudanças pequenas e focadas; explicar o que mudou e por quê, em português.
- Antes de afirmar que algo funciona, rodar (`npm start`) ou testar com o padrão do harness. Se não deu para testar, dizer.
- Não adicionar dependência sem necessidade; o app precisa continuar leve e instalável sem build complexo.
- Não quebrar a regra "o renderer não faz rede".
- Ao mexer na esfera, olhar uma captura de tela; é visual, não dá para validar só lendo o código.
