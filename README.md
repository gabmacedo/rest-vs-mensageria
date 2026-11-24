# Etapa experimental — REST × RabbitMQ

Implementação do item 3.2 do artigo: dois serviços (entrada + processamento) por cenário, mesma regra de negócio (`src/shared`), diferença apenas na comunicação.

- `src/rest/*` — cenário 1: entrada chama o processamento via HTTP e só responde depois da gravação (201).
- `src/mq/*` — cenário 2: entrada publica numa fila durável com publisher confirm e responde 202; o consumidor (prefetch 10) grava e só então dá ack.
- `k6/teste.js` — testes da Tabela 1 (`TEST=baixa|crescente|pico|falha`) e o exploratório `limite`.
- `scripts/run-experiment.mjs` — orquestra as execuções (esvazia banco/fila, roda o k6, derruba o processamento no teste de falha, mede o tempo total no banco).
- `scripts/report.mjs` — consolida em `results/RESULTADOS.md` e `results/resumo.csv`.

```bash
docker compose --profile rest --profile mq build
node scripts/run-experiment.mjs --reps 3 --tests baixa,crescente,pico,falha --out results
node scripts/report.mjs results
```

`results-piloto/` é o teste inicial (durações × 0,15) usado para validar o ambiente.
