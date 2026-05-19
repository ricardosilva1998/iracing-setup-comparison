import { COLOR } from "../../styles";
import type { CarInClass } from "../../types";

interface Props {
  car: CarInClass;
}

export function CarShopCell({ car }: Props) {
  return (
    <div style={{
      display: "flex", flexDirection: "column", gap: "0.35rem",
      padding: "0.5rem 0.75rem", borderTop: `1px solid ${COLOR.border}`,
    }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
        <span style={{ fontWeight: 600, fontSize: 14 }}>{car.name}</span>
        <span style={{ fontSize: 11, color: COLOR.muted }}>
          {car.shops.length} {car.shops.length === 1 ? "shop" : "shops"}
        </span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem" }}>
        {car.shops.map((s) => (
          <a key={s.shopSlug} href={s.listingUrl} target="_blank" rel="noreferrer"
            style={{
              fontSize: 11, color: COLOR.muted, textDecoration: "none",
              border: `1px solid ${COLOR.border}`, padding: "0.15rem 0.5rem",
              borderRadius: 999, backgroundColor: COLOR.bg,
            }}
            title={`Open ${s.shopName} listing in browser`}
          >
            {s.shopName}
          </a>
        ))}
      </div>
    </div>
  );
}
