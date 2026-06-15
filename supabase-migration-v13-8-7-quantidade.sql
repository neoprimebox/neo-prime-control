-- Neo Prime Control v13.8.7
-- Execute este script no Supabase SQL Editor se a tabela pedidos ainda não tiver os campos de quantidade.
-- É seguro rodar mais de uma vez: IF NOT EXISTS evita erro se a coluna já existir.

ALTER TABLE public.pedidos
  ADD COLUMN IF NOT EXISTS quantidade integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS quantidade_fornecedor integer NOT NULL DEFAULT 1;

-- Garante que registros antigos não fiquem zerados ou nulos.
UPDATE public.pedidos
SET quantidade = 1
WHERE quantidade IS NULL OR quantidade < 1;

UPDATE public.pedidos
SET quantidade_fornecedor = quantidade
WHERE quantidade_fornecedor IS NULL OR quantidade_fornecedor < 1;

-- Recomendado para manter a qualidade dos dados.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_quantidade_minima_chk'
  ) THEN
    ALTER TABLE public.pedidos
      ADD CONSTRAINT pedidos_quantidade_minima_chk CHECK (quantidade >= 1);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pedidos_quantidade_fornecedor_minima_chk'
  ) THEN
    ALTER TABLE public.pedidos
      ADD CONSTRAINT pedidos_quantidade_fornecedor_minima_chk CHECK (quantidade_fornecedor >= 1);
  END IF;
END $$;
