# Neo Prime Control V21 Beta — Amazon Connected Edition

A V21 foi construída sobre o pacote V20 Beta Agent Edition. As telas, agentes, cadastros, relatórios, financeiro, operações, importações, Radar de Fornecedores e Neo Prime AI foram mantidos.

## Novidades

- Menu **Amazon Seller**.
- Autorização da conta Amazon por backend/OAuth.
- Verificação do status da conexão.
- Consulta dos anúncios da loja pela Listings Items API.
- Leitura de título, ASIN, SKU, preço e situação do anúncio.
- Importação e atualização do catálogo local.
- Correspondência primeiro por SKU e depois por ASIN para reduzir duplicidades.
- Sincronização individual ou de todos os produtos.
- Configuração de modo: criar/atualizar, apenas novos ou somente visualizar.
- Endpoint de pedidos conectado à Central de Agentes.
- Registro de atividades da integração.

## Importante

O ZIP contém a aplicação e o backend serverless necessário, mas a Amazon somente permitirá acesso depois que você cadastrar/autorizar uma aplicação SP-API na sua conta. Nenhuma senha do Seller Central deve ser colocada no código.

## Configuração no Vercel

1. Publique todo o conteúdo do pacote no mesmo projeto Vercel.
2. No projeto Vercel, abra **Settings > Environment Variables**.
3. Cadastre as variáveis mostradas no arquivo `.env.example`.
4. Na configuração da aplicação SP-API, use como Redirect URI:
   `https://SEU-DOMINIO.vercel.app/api/amazon/auth/callback`
5. Faça um novo deploy.
6. Abra **Amazon Seller** no Neo Prime Control.
7. Informe a URL principal do projeto, sem barra no final.
8. Clique em **Conectar conta Amazon** e conclua a autorização no Seller Central.
9. Volte ao sistema e clique em **Verificar conexão**.
10. Use **Consultar catálogo** e depois **Sincronizar produtos**.

## Variáveis necessárias

- `AMAZON_APPLICATION_ID`
- `AMAZON_LWA_CLIENT_ID`
- `AMAZON_LWA_CLIENT_SECRET`
- `AMAZON_REDIRECT_URI`
- `AMAZON_TOKEN_SECRET`

Para uma aplicação privada, também é possível configurar `AMAZON_REFRESH_TOKEN` diretamente no Vercel. Nesse caso, o botão de autorização pode ser dispensado, mas as demais variáveis ainda são necessárias.

## Segurança

- O refresh token não é salvo no localStorage.
- O backend troca o refresh token por access tokens temporários.
- No fluxo OAuth da V21, o refresh token é criptografado em cookie HttpOnly, Secure e SameSite=Lax.
- Para ambiente multiusuário ou produção de maior escala, recomenda-se migrar o token para uma tabela segura no Supabase ou outro cofre de segredos, associado ao usuário autenticado.

## Limitações da Beta

- A Amazon precisa aprovar/habilitar os papéis da aplicação SP-API.
- A sincronização automática configurada na interface é uma preferência preparada para a próxima camada de agendamento; nesta Beta, a consulta é executada pelo botão ou pela Central de Agentes.
- O endpoint de pedidos usa a Orders API v0 para compatibilidade com a estrutura existente. A Amazon lançou Orders API v2026-01-01; a migração deve ser feita antes da retirada da versão antiga.
- Dados restritos de compradores não são importados. O sistema usa “Cliente Amazon” quando a API não fornece dados pessoais permitidos.

## Compatibilidade

Os dados locais e configurações da V20 são preservados porque a V21 utiliza as mesmas chaves anteriores e acrescenta apenas as chaves `npc_v21_*`.

## Correção V21.0.1 — deploy Vercel

O campo `functions.runtime` foi removido do `vercel.json`. Para funções JavaScript dentro da pasta `/api`, a Vercel detecta automaticamente o runtime Node.js. A versão do Node foi fixada em `22.x` pelo arquivo `package.json`.


## V21.0.2 — correção de implantação

O arquivo `vercel.json` foi removido integralmente. A Vercel detecta automaticamente os arquivos JavaScript em `/api` como Functions Node.js. O projeto deve ser enviado ao GitHub com os arquivos na raiz do repositório.
