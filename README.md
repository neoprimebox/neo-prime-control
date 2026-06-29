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
