Atue como engenheiro sênior de software especializado em players web e streaming. Trabalhe no projeto IPTV existente e implemente o que for necessário para que o teste e a reprodução funcionem pelo próprio caminho do aplicativo, não apenas no VLC ou em ferramentas externas. Não pare em recomendações ou mensagens de erro: corrija a arquitetura e o código onde isso for viável.

## Objetivo

Reduzir ao máximo as falhas de reprodução causadas pela arquitetura atual, pelo CORS e por formatos comuns de streams, mantendo o testador e o editor de M3U/M3U8 funcionais. Preserve as funcionalidades existentes, os dados e a stack do projeto sempre que possível.

## Investigue e implemente

1. Inspecione o repositório, o player, o importador, o testador e os testes. Identifique por que o navegador não consegue carregar canais e quais falhas são corrigíveis no aplicativo.
2. Implemente um relay de mídia no próprio projeto quando necessário para encaminhar streams pelo caminho do player e eliminar dependência direta de CORS entre o navegador e a origem. Faça streaming incremental, sem baixar o vídeo inteiro para memória ou disco.
3. Trate corretamente HLS: manifeste principal, playlists variantes, caminhos relativos, segmentos, parâmetros de URL e respostas parciais/headers de range quando necessários. Reescreva as referências dos manifests para que os recursos derivados também passem pelo relay sem quebrar a reprodução.
4. Use o player ou bibliotecas apropriadas para os formatos realmente suportados. Detecte HLS nativo e suporte a Media Source Extensions no navegador. Para formatos que não possam ser reproduzidos diretamente, avalie remux ou transcodificação apenas se forem necessários e tecnicamente sustentáveis; implemente o caminho adequado no projeto ou explique com precisão o requisito externo que impede fazê-lo.
5. Faça o teste de reprodução no navegador usando o mesmo relay e player da experiência normal. Só marque um canal como reproduzido após a mídia efetivamente iniciar. Diferencie endpoint acessível de reprodução real.
6. Corrija também a importação de playlists por URL quando o browser bloquear a requisição, usando o serviço do projeto quando for tecnicamente viável. Preserve playlists válidas se uma atualização falhar.
7. Mantenha o editor de canais e grupos integrado: resultados do teste devem permitir filtrar, desativar, excluir com possibilidade de desfazer, mover/renomear canais e exportar M3U atualizada.

## Robustez e proteção do serviço

O relay deve ser parte do aplicativo, não um proxy público sem controle. Restrinja o uso a requisições iniciadas pela aplicação e a fontes que o usuário configurou para uso autorizado. Valide URLs, protocolos, DNS, endereços IPv4/IPv6 e redirects. Cancele conexões quando o usuário interromper o teste ou fechar o player.

## Status claros e teste confiável

Melhore os estados para distinguir: reproduzindo; endpoint acessível sem playback confirmado; erro de importação; falha de rede; timeout; manifesto inválido; formato/codec incompatível; origem indisponível; acesso negado; e erro desconhecido. Explique o próximo passo útil em linguagem simples.

Como streams ao vivo mudam com o tempo, mantenha horário e duração do último teste. Adicione revalidação e opção para testar novamente, para que um resultado antigo não seja apresentado como garantia atual. Use timeouts e concorrência limitada para evitar sobrecarga na origem.

## Critérios de implementação

- Examine o código antes de alterar a arquitetura e adapte a implementação à stack encontrada.
- Não remova controles ou erros para que o canal apenas pareça funcionar.
- Não simule playback nem use uma resposta HTTP 200 como prova de sucesso.
- Crie testes automatizados para manifests HLS master/variant, URLs relativas, segmentos, redirects, timeout, CORS, falhas de playback, cancelamento e bloqueio de destinos internos.
- Teste o fluxo completo no navegador: importar lista, testar canais, reproduzir um canal, interromper e retomar, editar a lista e exportar. Use streams de teste autorizados; diferencie fixtures locais de streams reais.
- Execute build, lint e testes disponíveis. Corrija scripts para que uma falha de teste resulte em falha real do comando.
- Não declare compatibilidade universal. Liste qualquer caso que continue sem solução e o motivo técnico concreto.

Ao terminar, resuma o que mudou, os arquivos principais, os comandos de teste e seus resultados reais, e o que ainda não pôde ser reproduzido. Verifique cada afirmação de conclusão contra uma execução real do teste correspondente.
