import { 
  defineWorkflow, 
  locator, 
  quietSettle, 
  ExecutionContext 
} from "@automata/sdk";

interface EnterpriseIntake {
  applicant: {
    legalName: string;
    fein: string;
    yearsInBusiness: number;
  };
  units: Array<{
    vin: string;
    deductible: number;
  }>;
}

export const CommercialAutoWorkflow = defineWorkflow<EnterpriseIntake>({
  id: "commercial-auto-enterprise-v2",
  name: "Commercial Auto Application Workflow",
  version: "2.1.0",
  scope: {
    matchUrls: ["https://*.ratingcarrier.com/quote/*"],
    allowedOrigins: ["https://auth.ratingcarrier.com", "https://ratingcarrier.com"]
  },
  defaults: {
    timeoutMs: 15000,
    quietPeriodMs: 400,
    maxRetries: 2
  }
})
  // 1. Navigation Step
  .navigate("StartQuote", {
    url: "https://ratingcarrier.com/quote/commercial-auto/new",
    waitUntil: "networkidle0"
  })

  // 2. Business Legal Name Step
  .fill("BusinessName", {
    locator: locator()
      .byRole("textbox", { name: /Legal Business Name/i })
      .byDataTestId("business-name-input")
      .byAttributes({ fieldRef: "Applicant.LegalName" })
      .bySelector("input[name='busName']"),
    value: (ctx) => ctx.input.applicant.legalName,
    strategy: {
      clearBeforeTyping: true,
      verification: "value-equals"
    }
  })

  // 3. Conditional Branch for New Ventures
  .when(
    (ctx) => ctx.input.applicant.yearsInBusiness < 2,
    (branch) => branch.fill("NewVentureExplanation", {
      locator: locator().byRole("textbox", { name: /Prior Commercial Experience/i }),
      value: "Owner possessed 10+ years commercial driving experience prior to corporate formation."
    })
  )

  // 4. Repeating Units Loop (Vehicles)
  .forEach("units", {
    collection: (ctx) => ctx.input.units,
    itemAlias: "unit",
    indexAlias: "unitIndex",
    body: (loop) => {
      loop
        .click("AddUnitButton", {
          locator: locator().byRole("button", { name: /Add Vehicle/i }),
          postWait: quietSettle(500)
        })
        .fill("VehicleVIN", {
          locator: locator().byRole("textbox", { name: /VIN/i }).bySelector("input[name='vin']"),
          value: (ctx) => ctx.current.unit.vin
        })
        .fill("DeductibleSelect", {
          locator: locator().byRole("combobox", { name: /Comprehensive Deductible/i }),
          value: (ctx) => `$${ctx.current.unit.deductible}`,
          fieldKind: "combobox"
        });
    }
  })

  // 5. Non-Destructive Calculation Advance
  .click("CalculateRate", {
    locator: locator().byRole("button", { name: /Calculate Rate|Recalculate/i }),
    postWait: { type: "settle", quietPeriodMs: 1200 },
    guardrails: { blockDestructiveSubmissions: true }
  });