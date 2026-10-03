# Jarvis

Assistente pessoal de desktop: esfera dourada animada, hora, clima, notícias e um resumo do dia falado em voz natural.
Tudo gratuito e sem chave de API.

## Rodar

Precisa do [Node.js](https://nodejs.org) 20 ou mais novo.

```bash
npm install
npm start
```

## Instalar no PC (abrir sozinho ao ligar)

```bash
npm run dist
```

Gera `dist/Jarvis Setup 0.1.0.exe`. Instale e abra uma vez: o Jarvis se registra no Windows para abrir no login,
esperando 20 s para não competir com o boot (ajustável). O Windows pode mostrar o aviso do SmartScreen porque o
instalador não é assinado; "Mais informações" > "Executar assim mesmo".

Com `npm start` o registro também é feito, mas aponta para esta pasta, então ela precisa continuar no mesmo lugar.

## Atalhos

| Tecla | Ação |
|---|---|
| F11 | Alterna tela cheia |
| Esc | Fecha os Ajustes; fora deles, sai da tela cheia |
| Ctrl + , | Abre/fecha os Ajustes |

## Ajustes

Pelo botão **Ajustes**: voz (Antonio, Francisca, Thalita), velocidade e tom, nome e pronúncia do nome, cidade do clima,
fontes de notícias (RSS), abrir ao ligar o PC, falar o resumo ao abrir, tela cheia e o atraso após o boot.
Há também uma prévia dos quatro estados da esfera (ocioso, ouvindo, pensando, falando).

Se a pronúncia do nome sair estranha, escreva-o como se fala em "Como o Jarvis deve pronunciar" (ex.: "Áxel").

As configurações ficam em `%APPDATA%\jarvis\settings.json`; o cache de voz, em `%APPDATA%\jarvis\tts-cache`.

## Como funciona

| Parte | Tecnologia |
|---|---|
| Janela e autostart | Electron |
| Esfera | Three.js (shaders, ~9 mil partículas; 30 quadros/s em repouso, 60 ao falar) |
| Voz | `edge-tts-universal` (mesmo serviço do Edge), com cache em disco das frases repetidas |
| Clima | Open-Meteo |
| Notícias | RSS direto das fontes (G1, Folha e Tecnoblog por padrão) |

**Sem internet:** o clima e as notícias mostram um aviso e tentam de novo a cada 2 minutos. O resumo falado usa a voz do
Windows como reserva (frases que já estão no cache continuam na voz natural).

**Atenção:** o edge-tts usa um endpoint não oficial da Microsoft. É gratuito e estável há anos, mas sem garantia; se
mudarem algo, a voz cai para a reserva até o pacote ser atualizado (`npm update edge-tts-universal`).

## Estrutura

```
main.js          janela, autostart e ponte (IPC)
preload.js       API segura exposta à tela
src/             configurações, voz, clima e notícias (processo principal)
renderer/        interface: orb.js (esfera), voice.js, format.js, app.js
renderer/vendor/ Three.js r186 (MIT) e fonte Saira (SIL OFL), embutidos para funcionar offline
```

## Próximas fases

2. Agenda e tarefas do dia (Google Calendar e Google Tasks)
3. Perguntas e respostas com IA (API gratuita, com modelo local pequeno como reserva)
4. Voz de entrada (Vosk ou Whisper)

## Atualizar no Windows

Clone o projeto uma vez (precisa do Git instalado):

```
git clone -b claude/jarvis-computer-project-ts8onz https://github.com/wenzel-max/jarvis.git
```

Depois, dê dois cliques em `atualizar.bat` para baixar as novidades, instalar dependências e abrir o app. Para só abrir, use `iniciar.bat`. As configurações ficam em `%APPDATA%\jarvis`, então atualizar não apaga nada.
