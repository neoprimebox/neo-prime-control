# Neo Prime Control v13.8.7

Baseada na v13.8.6.

## Alteração principal

Incluído suporte a **quantidade vendida por pedido**, para casos em que o cliente compra 2, 3 ou mais unidades do mesmo produto.

## O que mudou

- Novo campo **Quantidade vendida** no formulário de pedidos.
- Novo campo **Quantidade vendida** na revisão de importação por JSON/IA.
- Tabela de pedidos agora exibe a coluna **Qtd**.
- Receita passa a considerar: `preço unitário vendido x quantidade + frete cobrado`.
- Custo do fornecedor passa a considerar: `preço de compra x quantidade + frete compra - desconto`.
- Relatórios, dashboard, financeiro, top produtos e histórico do cliente passam a usar a quantidade real vendida.
- Importação CSV/Excel já continua aceitando colunas como `Quantidade`, `Qtd` e similares.

## Banco de dados Supabase

Se a tabela `pedidos` ainda não tiver as colunas `quantidade` e `quantidade_fornecedor`, execute o arquivo:

`supabase-migration-v13-8-7-quantidade.sql`

no SQL Editor do Supabase.

Se essas colunas já existirem, o script pode ser rodado mesmo assim sem problema.
