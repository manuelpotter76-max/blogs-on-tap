-- The third tier is called Premium in Zoho Billing (plan code "premium").
-- Same price and allowance as before: $199, 8 articles a month.
update app.plans set code = 'premium', name = 'Premium' where code = 'authority';
update app.plan_versions set zoho_plan_code = 'premium' where zoho_plan_code = 'authority';
