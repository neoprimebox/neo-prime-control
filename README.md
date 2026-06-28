# Neo Prime Control v13.9

Baseada na v13.8.8.

## Correções desta versão

1. Ao editar um pedido pela tabela, o sistema agora tenta identificar automaticamente o produto por ID, por nome normalizado e por similaridade de palavras.
2. Ao digitar/colar o código da compra no campo “Código da compra / Nº pedido”, se o pedido já existir, ele é carregado automaticamente para edição.
3. Quando o produto é encontrado por nome em um pedido antigo/importado sem produto_id, o sistema grava de volta o vínculo produto_id/nome_produto no pedido.
4. O seletor de produto é reconstruído antes do preenchimento do formulário para evitar ficar vazio ou perder a opção do produto identificado.
5. Versão exibida no app atualizada para 13.9.

## Supabase

Não foi criada nenhuma coluna nova nesta versão. Basta subir os arquivos atualizados no GitHub/Vercel.
