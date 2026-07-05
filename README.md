# Neo Prime Control v13.9.1

Correções principais:

1. Ao editar ou carregar pedido, o produto agora é preenchido no campo Produto depois da renderização da tela, evitando que o select volte para "Selecione...".
2. Busca principal com Enter:
   - Em Pedidos: busca pelo número Amazon e carrega o formulário do pedido.
   - Em Produtos: busca por nome, ASIN ou SKU e preenche o formulário do produto.
   - Em Clientes: abre edição do cliente encontrado.
   - Em Fornecedores: abre edição do fornecedor encontrado.
3. Ações dos pedidos movidas para a primeira coluna, fixa à esquerda, com botões em bloco para não precisar rolar até o final da tabela.
4. Mantida a rotina de atualização do link/valor de compra no cadastro do produto ao salvar pedido.

Não exige SQL novo no Supabase.


## v13.9.3
- Corrigido o filtro de mês do Financeiro para usar campo mês sem lista duplicada visual.
- Mantidos: filtro por mês, mês atual, limpar filtro, botão limpar contexto, sino removido e contador fixo de mensagens removido.


## V13.9.4 - Conta de compra
- Cadastro de pedidos ganhou Marketplace da compra.
- Cadastro de pedidos ganhou Conta usada na compra, com sugestões para Shopee Principal, Shopee 02 e Shopee 03.
- Listagem de pedidos agora mostra a conta utilizada na compra.
- Busca global de pedidos também encontra pela conta utilizada.
- Compatível com Supabase atual: os novos dados são salvos dentro das observações técnicas do pedido, sem exigir alteração imediata na tabela.
