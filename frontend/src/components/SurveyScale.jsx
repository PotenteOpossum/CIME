import { useRef } from "react";
import {
  surveyChoiceGroups,
  surveyScale,
  isNumericSurveyScale,
} from "../../../shared/surveyScale.mjs";
export { isNumericSurveyScale };

function endpointLabel(question, entry, isLow) {
  if (entry?.label) return entry.label;
  return isLow ? question.minLabel || "Minimum" : question.maxLabel || "Maximum";
}

export default function SurveyScale({ question, value, onChange }) {
  const scale = surveyScale(question);
  const choices = scale ? null : surveyChoiceGroups(question);
  const radios = useRef([]);
  if (!scale && !choices) return null;

  const entries = scale
    ? scale.values
    : choices.options.map((option) => ({ option, value: option, label: option }));
  const alternatives = scale ? scale.alternatives : choices.alternatives;
  const isNumeric = Boolean(scale);
  const selected = entries.find((entry) => entry.option === value);
  const groupLabel = `${question.label}${isNumeric ? " rating" : ""}`;
  const first = scale?.values[0].value;
  const last = scale?.values.at(-1).value;
  const middle = scale?.values[Math.floor((scale.values.length - 1) / 2)];
  const shortOptions =
    !isNumeric &&
    entries.length <= 7 &&
    entries.every((entry) => entry.option.trim().length <= 36);
  const longOptions =
    !isNumeric && entries.some((entry) => entry.option.trim().length > 36);

  function select(entry) {
    onChange(entry.option);
  }

  function onRadioKeyDown(event, index) {
    let nextIndex;
    if (event.key === "ArrowRight" || event.key === "ArrowDown")
      nextIndex = Math.min(entries.length - 1, index + 1);
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp")
      nextIndex = Math.max(0, index - 1);
    else if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = entries.length - 1;
    else return;
    event.preventDefault();
    radios.current[nextIndex]?.focus();
    select(entries[nextIndex]);
  }

  return (
    <div
      className={`survey-scale${isNumeric ? " survey-scale-numeric" : " survey-choice-selector"}${isNumeric && entries.length > 5 ? " is-slider-mobile" : ""}`}
    >
      <div
        className={
          isNumeric
            ? "survey-scale-values"
            : `survey-choice-options${shortOptions ? " is-short" : ""}${longOptions ? " is-long" : ""}${entries.length > 7 && !longOptions ? " is-many" : ""}`
        }
        style={{ "--survey-scale-count": entries.length }}
        role="radiogroup"
        aria-label={groupLabel}
      >
        {entries.map((entry, index) => {
          const checked = selected === entry;
          return (
            <button
              key={entry.option}
              ref={(element) => { radios.current[index] = element; }}
              type="button"
              role="radio"
              aria-checked={checked}
              aria-label={isNumeric ? `${entry.value}${entry.label ? `, ${entry.label}` : ""}` : entry.option}
              tabIndex={checked || (!selected && index === 0) ? 0 : -1}
              className={`${isNumeric ? "survey-scale-value" : "survey-choice-button"}${checked ? " is-selected" : ""}`}
              onClick={() => select(entry)}
              onKeyDown={(event) => onRadioKeyDown(event, index)}
            >
              {isNumeric ? entry.value : entry.option}
            </button>
          );
        })}
      </div>
      {isNumeric && entries.length > 5 && (
        <div className="survey-scale-slider-wrap">
          <label
            className="survey-scale-slider-label"
            htmlFor={`${question.id}-range`}
          >
            {selected
              ? `Selected: ${selected.value}`
              : `Choose a value from ${first} to ${last}`}
          </label>
          <input
            id={`${question.id}-range`}
            className={`survey-scale-slider${selected ? " has-selection" : ""}`}
            type="range"
            min={first}
            max={last}
            step="1"
            value={selected?.value ?? middle.value}
            aria-label={groupLabel}
            aria-valuetext={selected ? String(selected.value) : "No value selected"}
            onChange={(event) => {
              const entry = entries.find(
                (item) => item.value === Number(event.target.value),
              );
              if (entry) select(entry);
            }}
          />
        </div>
      )}
      {isNumeric && (
        <div
          className="survey-scale-labels"
          style={{
            "--survey-middle-position": `${(entries.indexOf(middle) / (entries.length - 1)) * 100}%`,
          }}
          aria-hidden="true"
        >
          <span className="survey-scale-label-low">
            {endpointLabel(question, entries[0], true)}
          </span>
          <span className="survey-scale-label-middle">
            {middle.label || question.midLabel || String(middle.value)}
          </span>
          <span className="survey-scale-label-high">
            {endpointLabel(question, entries.at(-1), false)}
          </span>
        </div>
      )}
      {alternatives.length > 0 && (
        <div
          className="survey-scale-alternatives"
          role="radiogroup"
          aria-label={`${question.label} alternative answers`}
        >
          {alternatives.map((option) => (
            <label key={option} className="survey-scale-alternative">
              <input
                type="radio"
                name={`${question.id}-alternative`}
                checked={value === option}
                onChange={() => onChange(option)}
              />
              <span>{option}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
