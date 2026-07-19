# Correção de deploy Vercel

Foi removida do `vercel.json` a configuração manual:

```json
"functions": { "api/**/*.js": { "runtime": "nodejs20.x" } }
```

A Vercel detecta automaticamente as funções JavaScript da pasta `/api` e utiliza o runtime Node.js suportado pelo projeto.

## Publicação

1. Substitua os arquivos do repositório pelos deste pacote.
2. Confirme que o `vercel.json` da raiz foi atualizado.
3. Faça commit e push para a branch `main`.
4. Aguarde o novo deploy da Vercel.

Caso o mesmo erro continue, confira em Settings > General se o Root Directory aponta para a pasta que realmente contém este `vercel.json`.
