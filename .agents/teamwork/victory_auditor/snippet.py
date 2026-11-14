"""
Automata Python SDK (Python 3.10+)
Fully typed async automation engine running on Playwright or native CDP.
"""

from pydantic import BaseModel, Field
from automata_sdk import Workflow, Locator, StepContext, quiet_settle

class ApplicantModel(BaseModel):
    legal_name: str
    fein: str
    years_in_business: int

class UnitModel(BaseModel):
    vin: str
    deductible: int

class CommercialAutoPayload(BaseModel):
    applicant: ApplicantModel
    units: list[UnitModel]

workflow = Workflow[CommercialAutoPayload](
    id="commercial-auto-py-v2",
    name="Python Commercial Auto Workflow",
    scope_urls=["https://*.ratingcarrier.com/quote/*"],
    default_timeout_ms=15000,
    quiet_period_ms=400
)

@workflow.step(name="FillBusinessName")
async def fill_business_name(ctx: StepContext[CommercialAutoPayload]):
    target = (
        Locator()
        .by_role("textbox", name="Legal Business Name")
        .by_data_testid("business-name-input")
        .by_attribute("fieldRef", "Applicant.LegalName")
        .by_css("input[name='busName']")
    )
    await ctx.actions.fill(
        locator=target,
        value=ctx.input.applicant.legal_name,
        clear_before=True
    )

@workflow.loop(name="ProcessUnits", collection_path="units")
async def process_units(ctx: StepContext[CommercialAutoPayload], unit: UnitModel, idx: int):
    # Add Unit
    await ctx.actions.click(
        Locator().by_role("button", name="Add Vehicle"),
        post_wait=quiet_settle(500)
    )
    # Fill VIN
    await ctx.actions.fill(
        Locator().by_role("textbox", name="VIN").by_css("input[name='vin']"),
        value=unit.vin
    )
    # Choose Deductible
    await ctx.actions.select_option(
        Locator().by_role("combobox", name="Comprehensive Deductible"),
        value=f"${unit.deductible}"
    )

@workflow.on_step_failure
async def handle_step_failure(ctx: StepContext[CommercialAutoPayload], error: Exception):
    ctx.logger.error(f"Step {ctx.current_step.name} failed: {error}")
    await ctx.diagnostics.capture_full_trace()