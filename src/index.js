
const MODELS = [
  "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash"
];

const MAX_ATTEMPTS_PER_MODEL = 2;
const TIMEOUT_MS = 90000;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8"
    }
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function toBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunkSize)
    );
  }

  return btoa(binary);
}

function isTemporaryError(status) {
  return [
    0, 408, 429, 500, 502, 503, 504
  ].includes(status);
}

async function callGemini(model, apiKey, contents) {
  let lastError = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": apiKey
          },
          body: JSON.stringify({
            contents: [{
              role: "user",
              parts: contents
            }],
            generationConfig: {
              responseMimeType: "application/json",
              temperature: 0.1
            }
          }),
          signal: AbortSignal.timeout(TIMEOUT_MS)
        }
      );

      const responseText = await response.text();

      let result;

      try {
        result = JSON.parse(responseText);
      } catch {
        result = {};
      }

      if (!response.ok) {
        lastError = {
          status: response.status,
          message: result.error?.message ||
            "Il servizio Gemini non ha restituito una risposta valida."
        };

        if (
          attempt < MAX_ATTEMPTS_PER_MODEL &&
          isTemporaryError(response.status)
        ) {
          await sleep(attempt === 1 ? 2000 : 4000);
          continue;
        }

        return {
          success: false,
          ...lastError
        };
      }

      const output = result.candidates?.[0]?.content?.parts
        ?.map(part => part.text || "")
        .join("");

      if (!output) {
        lastError = {
          status: 502,
          message: "Gemini non ha restituito un testo leggibile."
        };

        return {
          success: false,
          ...lastError
        };
      }

      let parsed;

      try {
        parsed = JSON.parse(output);
      } catch {
        lastError = {
          status: 502,
          message: "Gemini ha restituito un JSON non valido."
        };

        return {
          success: false,
          ...lastError
        };
      }

      if (!Array.isArray(parsed.questions)) {
        return {
          success: false,
          status: 502,
          message: "Non è stato possibile individuare le domande."
        };
      }

      return {
        success: true,
        model,
        questions: parsed.questions
      };

    } catch (error) {
      lastError = {
        status: 0,
        message: error.name === "TimeoutError"
          ? "Tempo di risposta Gemini scaduto."
          : error.message || "Errore di connessione a Gemini."
      };

      if (attempt < MAX_ATTEMPTS_PER_MODEL) {
        await sleep(attempt === 1 ? 2000 : 4000);
      }
    }
  }

  return {
    success: false,
    ...lastError
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (
      url.pathname === "/api/health" &&
      request.method === "GET"
    ) {
      return json({
        status: "online",
        geminiConfigured: Boolean(env.GEMINI_API_KEY)
      });
    }

    if (
      url.pathname === "/api/solve" &&
      request.method === "POST"
    ) {
      try {
        if (!env.GEMINI_API_KEY) {
          return json({
            error: "Chiave Gemini non configurata su Cloudflare."
          }, 500);
        }

        const contentLength = Number(
          request.headers.get("content-length") || 0
        );

        if (contentLength > 15 * 1024 * 1024) {
          return json({
            error: "Le immagini superano il limite di 15 MB."
          }, 413);
        }

        const form = await request.formData();

        const files = form.getAll("images").filter(
          item => item && typeof item.arrayBuffer === "function"
        );

        const mode = String(form.get("mode") || "both");
        const subject = String(
          form.get("subject") || "Statistica"
        );

        if (files.length === 0) {
          return json({
            error: "Non hai caricato immagini."
          }, 400);
        }

        if (files.length > 30) {
          return json({
            error: "Puoi caricare al massimo 30 immagini."
          }, 400);
        }

        const allowedTypes = [
          "image/jpeg",
          "image/png",
          "image/webp"
        ];

        let totalSize = 0;
        const imageParts = [];

        for (const file of files) {
          if (!allowedTypes.includes(file.type)) {
            return json({
              error: "Formato non supportato. Usa JPG, PNG o WEBP."
            }, 400);
          }

          if (file.size > 5 * 1024 * 1024) {
            return json({
              error: "Una delle immagini supera 5 MB."
            }, 413);
          }

          totalSize += file.size;

          if (totalSize > 15 * 1024 * 1024) {
            return json({
              error: "Il totale delle immagini supera 15 MB."
            }, 413);
          }

          const bytes = new Uint8Array(
            await file.arrayBuffer()
          );

          imageParts.push({
            inlineData: {
              mimeType: file.type,
              data: toBase64(bytes)
            }
          });
        }

        const prompt = `
Sei RISOLVI QUIZ PROFESSIONAL, un assistente specializzato
nella risoluzione e verifica di quiz universitari italiani.

OBIETTIVO PRINCIPALE:
Risolvere quiz di STATISTICA con precisione matematica,
controllando ogni risposta prima di restituirla.

MATERIA SELEZIONATA: ${subject}
MODALITÀ: ${mode}

REGOLE OBBLIGATORIE:

1. Analizza tutte le immagini caricate, senza saltarne nessuna.

2. Individua e trascrivi ogni domanda e tutte le alternative
   disponibili, rispettando la numerazione originale.

3. Leggi con attenzione simboli matematici, indici, esponenti,
   parentesi, frazioni, percentuali e unità di misura.

4. Distingui correttamente concetti statistici come:
   media aritmetica, mediana, moda, varianza, deviazione standard,
   frequenze, probabilità, distribuzioni, correlazione,
   regressione, campionamento e inferenza statistica.

5. Per ogni esercizio numerico:
   - identifica i dati forniti;
   - individua la formula corretta;
   - sostituisci i valori senza alterare i dati;
   - esegui i calcoli in modo ordinato;
   - controlla il risultato;
   - confronta il risultato con tutte le alternative.

6. Controlla attentamente le differenze tra:
   - varianza e deviazione standard;
   - popolazione e campione;
   - frequenza assoluta e relativa;
   - probabilità semplice e condizionata;
   - correlazione e causalità;
   - percentuale e valore decimale.

7. Non scegliere una risposta soltanto perché sembra plausibile.
   La risposta deve essere coerente con la teoria o con il calcolo.

8. Prima di assegnare A, B, C o D, verifica che il testo
   dell'alternativa corrisponda effettivamente al risultato.

9. Se nessuna alternativa coincide con il risultato,
   segnala il problema nel campo warning.
   Non forzare una risposta.

10. Se un dato, una formula o una parte della domanda
    non è leggibile, dichiaralo esplicitamente.

11. Non inventare domande, numeri, formule o alternative.

12. Non dichiarare una risposta verificata se non hai
    effettivamente controllato il procedimento.

13. In caso di dubbio, indica confidence "bassa"
    e descrivi il motivo.

MODALITÀ DI RISPOSTA:

- Se mode è "exam", fornisci risposte concise,
  mantenendo numero, lettera e risultato essenziale.

- Se mode è "both", fornisci trascrizione, risposta,
  spiegazione e procedimento di verifica.

RESTITUISCI ESCLUSIVAMENTE JSON VALIDO
con questa struttura:

{
  "questions": [
    {
      "number": 1,
      "subject": "Statistica",
      "question": "Testo completo della domanda",
      "answer": "A",
      "confidence": "alta",
      "verification": "Verificata",
      "explanation": "Spiegazione della risposta",
      "calculation": "Formula e passaggi del calcolo",
      "verification_details": "Controllo matematico effettuato",
      "warning": ""
    }
  ]
}

Non aggiungere testo fuori dal JSON.
`;

        const contents = [
          { text: prompt },
          ...imageParts
        ];

        let finalResult = null;

        for (const model of MODELS) {
          const result = await callGemini(
            model,
            env.GEMINI_API_KEY,
            contents
          );

          if (result.success) {
            finalResult = result;
            break;
          }

          finalResult = result;

          const canFallback =
            isTemporaryError(result.status) ||
            result.status === 404;

          if (!canFallback) {
            break;
          }
        }

        if (!finalResult?.success) {
          return json({
            error: "Gemini non è riuscito a elaborare il quiz.",
            details: finalResult?.message ||
              "Servizio AI temporaneamente non disponibile.",
            status: finalResult?.status || 502
          }, 502);
        }

        return json({
          success: true,
          model: finalResult.model,
          questions: finalResult.questions
        });

      } catch (error) {
        return json({
          error: error.name === "TimeoutError"
            ? "Analisi troppo lunga. Riprova con meno immagini."
            : "Errore durante l'analisi delle immagini.",
          details: error.message
        }, 500);
      }
    }

    if (url.pathname.startsWith("/api/")) {
      return json({
        error: "Endpoint non trovato."
      }, 404);
    }

    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response("Sito non disponibile.", {
      status: 404
    });
  }
};
