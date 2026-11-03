# Sinal — Estúdio de Playlists IPTV

Ferramenta web para **importar, testar de verdade, reproduzir, editar e exportar** playlists IPTV (M3U/M3U8),
construída sobre Next.js + TypeScript.

## O que ela faz

- **Importação resiliente** por arquivo local (`.m3u`/`.m3u8`), URL `http(s)://` ou texto colado.
  Quando o navegador bloqueia a leitura direta da URL por CORS, a aplicação encaminha automaticamente
  a busca pelo serviço integrado (`POST /api/import-playlist`) com proteção SSRF. Se uma tentativa de
  atualização ou nova importação falhar, a playlist válida atual e todas as edições do usuário são preservadas.
- **Relay de mídia integrado (`/api/stream-relay`)**: encaminha streams pelo próprio caminho do aplicativo
  para eliminar falhas de CORS entre o navegador e a origem.
  - Faz **streaming incremental** (`ReadableStream` com controle de backpressure), sem baixar o vídeo inteiro para memória ou disco.
  - Reescreve automaticamente manifestos **HLS** (`#EXTM3U` master playlists, playlists variantes, `#EXT-X-MEDIA`, `#EXT-X-MAP`, `#EXT-X-KEY`, `#EXT-X-I-FRAME-STREAM-INF`), resolvendo caminhos relativos, subpastas, parâmetros de URL e redirecionamentos para que todos os recursos derivados passem pelo relay.
  - Suporta cabeçalhos `Range` / `If-Range` e respostas parciais (`206 Partial Content` + `Content-Range`).
  - Propaga diretivas seguras `#EXTVLCOPT:http-user-agent` e `#EXTVLCOPT:http-referrer` configuradas no canal.
  - Encerra imediatamente a conexão com a origem quando o usuário interrompe o teste ou fecha/para o player.
- **Teste real de reprodução no navegador**: usa o mesmo relay e motor do player (`hls.js` via Media Source Extensions com remux MPEG-TS → fMP4, ou HLS/mídia nativa).
  - Um canal só recebe o estado **“Reproduzindo”** (`playing`) após dados reais de mídia entrarem no buffer decodificado do player (`FRAG_BUFFERED` com bytes em `video.buffered` ou `loadeddata`/`playing`).
  - Estados claros e distintos com explicação do próximo passo útil:
    `playing` (Reproduzindo) · `reachable_unconfirmed` (Acessível, sem playback confirmado) · `import_error` (Erro de importação) · `network_error` (Falha de rede) · `timeout` (Timeout) · `blocked_cors` (Bloqueado por CORS) · `auth_failed` (Acesso negado) · `manifest_invalid` (Manifesto inválido) · `codec_unsupported` (Formato/codec incompatível) · `unavailable` (Origem indisponível) · `undetermined` (Erro desconhecido).
  - Registra **horário e duração** do último teste, sinaliza resultados antigos (`antigo · revalide`) e oferece **Revalidar antigos / Testar novamente** e **Repetir falhas** com concorrência limitada (3) e timeout por canal.
- **Editor integrado e reversível**: filtrar por estado/grupo/busca, renomear, alterar logo, mover entre grupos, ativar/desativar (individualmente, em lote ou desativar falhas), excluir para lixeira com desfazer/refazer, restaurar original e exportar M3U atualizada.

## Proteção do serviço e privacidade

- **Não é um proxy público aberto**: `/api/stream-relay` restringe o uso a requisições de mesma origem (`Sec-Fetch-Site` / `Origin` / `Referer`) e exige assinatura HMAC-SHA256 ou token de sessão vinculado apenas às fontes que o usuário importou/autorizou na aplicação.
- **Proteção SSRF rigorosa**: validação de URL, protocolo (`http`/`https`), bloqueio de loopback (`127.0.0.0/8`, `::1`), RFC1918 (`10/8`, `172.16/12`, `192.168/16`), link-local e metadados de nuvem (`169.254.169.254`), CGNAT, ULA/IPv6 mapeado, resolução DNS validada no momento da conexão (anti-rebinding) e redirecionamentos revalidados hop a hop.
- **Persistência local**: documento da playlist, edições e resultados ficam no IndexedDB do navegador (`sinal-playlist-studio`). Credenciais e tokens em URLs são redigidos (`redactUrl`).

## Rodando

```bash
npm run dev        # servidor de desenvolvimento
npm run build      # build de produção
npm run start      # servir build de produção
npm run lint       # ESLint
npm run typecheck  # TypeScript
npm test           # suíte automatizada (Vitest)
```

## Limites técnicos conhecidos (honestidade técnica)

- **Codecs sem suporte no navegador**: transmissões que utilizam áudio Dolby AC-3/E-AC-3, DTS, ou vídeo HEVC/H.265 em navegadores/sistemas operacionais sem decodificador de hardware licenciado não podem ser decodificadas via MSE sem transcodificação em servidor externo.
- **Contêineres legados e protocolos não-HTTP**: arquivos `.avi`/`.wmv`/`.divx`, `.mkv` com trilhas incompatíveis, ou fluxos `rtmp://`, `rtsp://` e `udp://` exigem um processo externo de transcodificação (ex.: binário `ffmpeg` dedicado), não incluído na execução web/Node padrão.
- **DRM e bloqueios de IP da origem**: canais protegidos por Widevine/FairPlay sem servidor de licença configurado ou bloqueados geograficamente/por IP pelo provedor continuam retornando erro de codec/DRM ou acesso negado (`401`/`403`).
