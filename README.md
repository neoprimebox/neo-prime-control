# Neo Prime Control V13.8 - Supabase Relacional em Português

Esta versão foi montada a partir da V13.7 e usa as tabelas relacionais em português criadas no Supabase:

- fornecedores
- produtos
- clientes
- mensagens
- pedidos
- historico_mensagens
- importacoes_csv
- importacoes_ia
- configuracoes
- backups

## Antes de publicar

1. Abra `supabase-config.js`.
2. Mantenha a URL do projeto.
3. Cole a sua **Publishable Key / Anon Key** no campo `key`.
4. Não use Secret Key / Service Role Key.

## Como funciona

A aplicação mantém o localStorage como cache local para preservar a experiência da V13.7, mas sincroniza os registros com o Supabase.

Se o Supabase estiver vazio, a primeira abertura envia os dados locais/migrados para o banco.
Se o Supabase já tiver dados, a aplicação carrega as tabelas do banco e atualiza o cache local.

## Publicação

Envie estes arquivos para o GitHub substituindo a V13.7. A Vercel fará o deploy automaticamente.
