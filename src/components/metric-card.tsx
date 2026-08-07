type MetricTone = "neutral" | "success" | "warning" | "danger" | "accent";

type MetricCardProps = {
  label: string;
  tone?: MetricTone;
  symbol?: string;
  value: number;
};

export function MetricCard({ label, tone = "neutral", symbol, value }: MetricCardProps) {
  return (
    <div className={`mgmt-metric mgmt-metric--${tone}`} role="listitem">
      {symbol ? (
        <span className="mgmt-metric__mark" aria-hidden="true">{symbol}</span>
      ) : null}
      <div>
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}
