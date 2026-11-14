export const SUBMISSION_GUARDRAIL_LEXICON = {
  // Category 1: Attestation, Legal Assent & Electronic Signatures
  SIGNATURE_ATTESTATION: new RegExp(
    [
      '\\b(?:e[-_\\s]?)?sign(?:ing|ature|ed)?\\b',
      '\\battest(?:ation|ing)?\\b',
      '\\b(?:i\\s+)?declar(?:e|ation|ing)\\b',
      '\\b(?:i\\s+)?agree(?:ment)?\\b',
      '\\backnowledg(?:e|ment|ing)\\b',
      '\\bauthoriz(?:e|ation)\\s+payment\\b',
      '\\baccept\\s+terms\\b'
    ].join('|'),
    'i'
  ),

  // Category 2: Legal Policy Binding, Issuance & Execution
  POLICY_BINDING_ISSUANCE: new RegExp(
    [
      '\\bbind(?:ing|s)?\\b',
      '\\bbound\\b',
      '\\bissu(?:e|ing|ance|ed)\\b',
      '\\bexecut(?:e|ion|ing)\\b',
      '\\bunderwrit(?:e|ing)\\b',
      '\\brequest\\s+(?:issuance|bind(?:ing)?)\\b',
      '\\bconfirm\\s+coverage\\b',
      '\\bfinalize\\s+policy\\b'
    ].join('|'),
    'i'
  ),

  // Category 3: Financial Disbursements, Payments & Checkout
  FINANCIAL_TRANSACTION: new RegExp(
    [
      '\\bbuy(?:ing|s)?\\b',
      '\\bpurchas(?:e|ing|es|ed)?\\b',
      '\\bpay(?:ment|ing|s|ments)?\\b',
      '\\bpaid\\b',
      '\\bcheckout\\b',
      '\\bcharg(?:e|ing|es|ed)\\b',
      '\\bremit(?:tance)?\\b',
      '\\bdisburs(?:e|ement)\\b',
      '\\b(?:place|submit|process|confirm|make|remit|finalize)\\s+(?:an?\\s+)?(?:order|payment|purchase|charge|premium)\\b'
    ].join('|'),
    'i'
  ),

  // Category 4: Billable Third-Party Inquiries & Regulatory Records
  BILLABLE_REPORTS: new RegExp(
    [
      '\\bmvr\\b',
      '\\bc\\.?l\\.?u\\.?e\\.?\\b',
      '\\bcredit(?:\\s+score|\\s+report|\\s+check)?\\b',
      '\\bloss\\s+history\\b',
      '\\bdriving\\s+record\\b',
      '\\bmotor\\s+vehicle(?:\\s+record|\\s+report)?\\b',
      '\\bbackground\\s+check\\b',
      '\\b(?:order|pull|run|request)\\s+(?:an?\\s+)?(?:mvr|report|record|score|history)\\b'
    ].join('|'),
    'i'
  ),

  // Category 5: Multilingual Carrier Actions (Spanish, French, German)
  MULTILINGUAL_EXPANSION: new RegExp(
    [
      // Spanish (ES)
      '\\b(?:firmar?|firma|signatario|atestiguar)\\b',
      '\\b(?:emitir|emisi[oó]n|formalizar|vincular)\\b',
      '\\b(?:pagar?|pago|comprar?|ordenar?|cobro|cargar|remitir)\\b',
      '\\b(?:finalizar\\s+compra|solicitar\\s+p[oó]liza)\\b',
      '\\b(?:registro\\s+de\\s+conducir|historial\\s+de\\s+p[eé]rdidas|informe\\s+crediticio)\\b',
      // French (FR)
      '\\b(?:signer?|signature|attester?)\\b',
      '\\b(?:[eé]mettre|[eé]mission|souscrire|souscription|adh[eé]rer)\\b',
      '\\b(?:payer?|paiement|acheter?|commander?|r[eé]gler|r[eé]glement)\\b',
      '\\b(?:dossier\\s+de\\s+conduite|relev[eé]\\s+d[\'’]information|fiche\\s+d[\'’]ant[eé]c[eé]dents)\\b',
      // German (DE)
      '\\b(?:unterschreib(?:en)?|unterschrift|signieren)\\b',
      '\\b(?:polizze\\s+ausstellen|ausstell(?:en)?|ausstellung|policieren)\\b',
      '\\b(?:bezahl(?:en)?|zahlung|kauf(?:en)?|bestell(?:en)?|kostenpflichtig\\s+bestellen|abbuchen)\\b',
      '\\b(?:deckung\\s+best[aä]tigen|versichern)\\b',
      '\\b(?:fahrzeugakte|verkehrszentralregister|schadenhistorie|auskunft\\s+einholen)\\b'
    ].join('|'),
    'i'
  )
};

export const NAVIGATION_ALLOWLIST_REGEX = new RegExp(
  [
    '\\b(?:save\\s*&\\s*continue|save\\s+and\\s+continue)\\b',
    '\\b(?:next|continue|proceed|forward|advance)\\b',
    '\\b(?:back|previous|return)\\b',
    '\\b(?:edit|review|view|summary)\\b',
    '\\b(?:calculate|recalculate|rate|re-?rate|get\\s+quote|view\\s+quote)\\b',
    '\\b(?:validate|verify|check\\s+errors)\\b',
    '\\b(?:add|new|create)\\s+(?:driver|vehicle|location|coverage|unit)\\b',
    '\\b(?:cancel|close|exit|dismiss)\\b'
  ].join('|'),
  'i'
);