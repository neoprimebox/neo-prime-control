# Neo Prime Control v20 Beta — Agent Edition

## Novidades

- Central de Agentes com execução manual segura.
- Agente de Novas Vendas preparado para consumir um endpoint backend conectado à Amazon SP-API.
- Importação de JSON de venda para teste sem credenciais da Amazon.
- Agente Comparador de Fornecedores usando:
  - fornecedor padrão e custos do catálogo;
  - fornecedor/custo já registrado no pedido;
  - candidatos salvos no Radar de Fornecedores.
- Agente de Decisão com fila de aprovação, fornecedor sugerido, economia e lucro previsto.
- Registro separado de:
  - número do pedido Amazon;
  - marketplace da compra;
  - número do pedido realizado no fornecedor/marketplace;
  - conta usada na compra.
- Histórico das execuções dos agentes.

## Integração Amazon

A aplicação não expõe credenciais da Amazon no navegador. O campo “Endpoint seguro do backend” espera uma API própria que consulte a Amazon SP-API e devolva uma lista JSON de pedidos.

Exemplo de resposta do backend:

```json
{
  "orders": [
    {
      "amazonOrderId": "701-1234567-1234567",
      "orderDate": "2026-07-09",
      "productName": "Produto exemplo",
      "sku": "SKU-001",
      "asin": "B000000000",
      "customerName": "Cliente Amazon",
      "salePrice": 99.90,
      "saleShipping": 0,
      "quantity": 1,
      "amazonFees": 14.50
    }
  ]
}
```

## Observação sobre Supabase

Os campos novos de marketplace, número do pedido no fornecedor e decisão do agente são armazenados dentro do bloco `NPC_ORDER_EXTRA` em `observacoes`, mantendo compatibilidade com a estrutura atual do banco e evitando exigir migração imediata.
