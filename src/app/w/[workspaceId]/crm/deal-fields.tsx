import type { Company, Contact, Deal, DealStage } from "@/server/modules/crm/service";
import type { Person } from "@/server/modules/members/service";

/** The fields of a deal, shared by the "new deal" and "edit deal" forms. */
export function DealFields({
  deal,
  stages,
  companies,
  contacts,
  people,
}: {
  deal?: Deal;
  stages: DealStage[];
  companies: Company[];
  contacts: Contact[];
  people: Person[];
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <label className="sm:col-span-2">
        <span className="label">What is the deal?</span>
        <input className="input" name="title" defaultValue={deal?.title} placeholder="New website for Harbor Cafe" required maxLength={200} />
      </label>
      <label>
        <span className="label">How much is it worth?</span>
        <input className="input" name="amount" type="number" min="0" step="0.01" defaultValue={deal?.amount ?? ""} placeholder="0.00" />
      </label>
      <label>
        <span className="label">Stage</span>
        <select className="input" name="stageId" defaultValue={deal?.stage_id ?? stages[0]?.id}>
          {stages.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      </label>
      <label>
        <span className="label">Company</span>
        <select className="input" name="companyId" defaultValue={deal?.company_id ?? ""}>
          <option value="">None</option>
          {companies.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <label>
        <span className="label">Contact</span>
        <select className="input" name="contactId" defaultValue={deal?.contact_id ?? ""}>
          <option value="">None</option>
          {contacts.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <label>
        <span className="label">Who looks after it?</span>
        <select className="input" name="ownerId" defaultValue={deal?.owner_id ?? ""}>
          <option value="">Nobody yet</option>
          {people.map((p) => (
            <option key={p.user_id} value={p.user_id}>{p.display_name}</option>
          ))}
        </select>
      </label>
      <label>
        <span className="label">When do you expect an answer?</span>
        <input className="input" name="expectedClose" type="date" defaultValue={deal?.expected_close ?? ""} />
      </label>
      <label className="sm:col-span-2">
        <span className="label">Notes (optional)</span>
        <textarea className="input min-h-20" name="notes" defaultValue={deal?.notes} maxLength={10000} />
      </label>
    </div>
  );
}
