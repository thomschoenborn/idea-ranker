"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DndContext,
  DragEndEvent,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  CartesianGrid,
  LabelList,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { supabase } from "@/lib/supabase/client";

type Step = "labels" | "ideas" | "sortX" | "sortY" | "result";

type Idea = {
  id: string;
  text: string;
};

type RankedPoint = {
  idea: string;
  x: number;
  y: number;
  xRank: number;
  yRank: number;
  labelPlacement: "right" | "below" | "above" | "none";
};

type SavedRankingRow = {
  id: number;
  axis_1_label: string;
  axis_2_label: string;
  ideas: unknown;
  created_at: string;
};

type SavedPoint = {
  idea: string;
  x: number;
  y: number;
  xRank: number;
  yRank: number;
};

type LabelPlacement = "right" | "below" | "above" | "none";

type Box = {
  left: number;
  right: number;
  top: number;
  bottom: number;
};

function shuffle<T>(array: T[]) {
  const items = [...array];
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function SortableIdeaCard({
  id,
  text,
  onEdit,
  onDelete,
}: {
  id: string;
  text: string;
  onEdit: (id: string, currentText: string) => void;
  onDelete: (id: string, currentText: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
    id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <li
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="group cursor-grab rounded-xl border border-zinc-200 bg-white p-4 shadow-sm active:cursor-grabbing"
    >
      <div className="flex items-start justify-between gap-3">
        <p className="font-medium text-zinc-800">{text}</p>
        <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onEdit(id, text);
            }}
            className="rounded border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100"
            aria-label={`Edit ${text}`}
            title="Edit item"
          >
            ✎
          </button>
          <button
            type="button"
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(id, text);
            }}
            className="rounded border border-zinc-200 px-2 py-0.5 text-xs text-zinc-600 hover:bg-zinc-100"
            aria-label={`Delete ${text}`}
            title="Delete item"
          >
            🗑
          </button>
        </div>
      </div>
    </li>
  );
}

function centeredValueFromRank(rank: number, total: number, topIsPositive: boolean) {
  if (total % 2 === 1) {
    const middle = (total + 1) / 2;
    const distanceFromMiddle = middle - rank;
    return topIsPositive ? distanceFromMiddle : -distanceFromMiddle;
  }

  const half = total / 2;
  const signedMagnitude = rank <= half ? half - rank + 1 : -(rank - half);
  return topIsPositive ? signedMagnitude : -signedMagnitude;
}

function todayStamp() {
  return new Date().toISOString().slice(0, 10);
}

function nextDefaultSeriesName(rows: SavedRankingRow[]) {
  const prefix = todayStamp();
  const used = rows
    .map((row) => {
      const ideas = typeof row.ideas === "object" && row.ideas ? (row.ideas as Record<string, unknown>) : {};
      const name = typeof ideas.series_name === "string" ? ideas.series_name : "";
      const match = name.match(new RegExp(`^${prefix}-(\\d+)$`));
      return match ? Number(match[1]) : 0;
    })
    .filter((n) => n > 0);
  const next = used.length ? Math.max(...used) + 1 : 1;
  return `${prefix}-${next}`;
}

function intersects(a: Box, b: Box) {
  return !(a.right < b.left || a.left > b.right || a.bottom < b.top || a.top > b.bottom);
}

function getPointPixel(point: { x: number; y: number }, plot: { width: number; height: number; maxAbsDomain: number }) {
  const domainSpan = plot.maxAbsDomain * 2;
  const xRatio = (point.x + plot.maxAbsDomain) / domainSpan;
  const yRatio = (plot.maxAbsDomain - point.y) / domainSpan;
  return {
    px: xRatio * plot.width,
    py: yRatio * plot.height,
  };
}

function getLabelBox(
  placement: Exclude<LabelPlacement, "none">,
  text: string,
  px: number,
  py: number,
): Box {
  const textWidth = Math.max(18, text.length * 6);
  const textHeight = 10;

  if (placement === "right") {
    return { left: px + 8, right: px + 8 + textWidth, top: py - 8, bottom: py + 4 };
  }
  if (placement === "below") {
    return { left: px - textWidth / 2, right: px + textWidth / 2, top: py + 6, bottom: py + 6 + textHeight };
  }
  return { left: px - textWidth / 2, right: px + textWidth / 2, top: py - 10, bottom: py };
}

function computePixelPlacements(
  points: { idea: string; x: number; y: number }[],
  plot: { width: number; height: number; maxAbsDomain: number },
) {
  const placedBoxes: Box[] = [];
  const dotRadius = 5;

  return points.map((point, index) => {
    const { px, py } = getPointPixel(point, plot);
    const dotBoxes = points
      .filter((_, i) => i !== index)
      .map((p) => {
        const pixel = getPointPixel(p, plot);
        return {
          left: pixel.px - dotRadius,
          right: pixel.px + dotRadius,
          top: pixel.py - dotRadius,
          bottom: pixel.py + dotRadius,
        };
      });

    const placements: Exclude<LabelPlacement, "none">[] = ["right", "below", "above"];
    let totalOverlaps = 0;

    for (const placement of placements) {
      const box = getLabelBox(placement, point.idea, px, py);
      const overlapsWithLabels = placedBoxes.some((existing) => intersects(existing, box));
      const overlapsWithDots = dotBoxes.some((dot) => intersects(dot, box));
      if (!overlapsWithLabels && !overlapsWithDots) {
        placedBoxes.push(box);
        return placement as LabelPlacement;
      }
      totalOverlaps += Number(overlapsWithLabels) + Number(overlapsWithDots);
      if (totalOverlaps > 3) return "none" as LabelPlacement;
    }

    return "none" as LabelPlacement;
  });
}

export default function Home() {
  const [step, setStep] = useState<Step>("labels");
  const [axis1, setAxis1] = useState("Effort");
  const [axis2, setAxis2] = useState("Impact");
  const [axis1TopLabel, setAxis1TopLabel] = useState("High effort");
  const [axis1BottomLabel, setAxis1BottomLabel] = useState("Low effort");
  const [axis2TopLabel, setAxis2TopLabel] = useState("High impact");
  const [axis2BottomLabel, setAxis2BottomLabel] = useState("Low impact");
  const [axis1LeftLabelPosition, setAxis1LeftLabelPosition] = useState<"top" | "bottom">("bottom");
  const [axis2TopLabelPosition, setAxis2TopLabelPosition] = useState<"top" | "bottom">("top");
  const [seriesName, setSeriesName] = useState("");
  const [shouldSave, setShouldSave] = useState(true);
  const [savedRows, setSavedRows] = useState<SavedRankingRow[]>([]);
  const [selectedSavedId, setSelectedSavedId] = useState("");
  const [ideaInput, setIdeaInput] = useState("");
  const [ideas, setIdeas] = useState<Idea[]>([]);
  const [xOrder, setXOrder] = useState<string[]>([]);
  const [yOrder, setYOrder] = useState<string[]>([]);
  const [saveStatus, setSaveStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [savedRankingId, setSavedRankingId] = useState<number | null>(null);
  const chartFrameRef = useRef<HTMLDivElement | null>(null);
  const [chartFrameSize, setChartFrameSize] = useState({ width: 0, height: 0 });

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));

  useEffect(() => {
    async function loadSavedRows() {
      const { data, error } = await supabase
        .from("idea_rankings")
        .select("id, axis_1_label, axis_2_label, ideas, created_at")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error || !data) return;
      setSavedRows(data as SavedRankingRow[]);
    }
    void loadSavedRows();
  }, []);

  useEffect(() => {
    async function loadSharedRankingFromUrl() {
      const params = new URLSearchParams(window.location.search);
      const rankingParam = params.get("ranking");
      if (!rankingParam) return;

      const rankingId = Number(rankingParam);
      if (!Number.isFinite(rankingId)) return;

      const { data, error } = await supabase
        .from("idea_rankings")
        .select("id, axis_1_label, axis_2_label, ideas, created_at")
        .eq("id", rankingId)
        .single();
      if (error || !data) {
        setSaveStatus(`Could not load shared ranking: ${error?.message ?? "Not found."}`);
        return;
      }
      const target = data as SavedRankingRow;
      const ideasMeta =
        typeof target.ideas === "object" && target.ideas ? (target.ideas as Record<string, unknown>) : {};
      const points = Array.isArray(ideasMeta.points) ? (ideasMeta.points as SavedPoint[]) : [];
      if (!points.length) {
        setSaveStatus("Shared ranking has no points.");
        return;
      }

      const loadedIdeas = points.map((point, index) => ({
        id: `loaded-${target.id}-${index}`,
        text: point.idea,
      }));
      const idByIdea = new Map(loadedIdeas.map((idea) => [idea.text, idea.id]));
      const xSorted = [...points].sort((a, b) => a.xRank - b.xRank).map((point) => idByIdea.get(point.idea) ?? "");
      const ySorted = [...points].sort((a, b) => a.yRank - b.yRank).map((point) => idByIdea.get(point.idea) ?? "");

      setAxis1(target.axis_1_label);
      setAxis2(target.axis_2_label);
      setAxis1TopLabel(typeof ideasMeta.axis_1_top_label === "string" ? ideasMeta.axis_1_top_label : "Top");
      setAxis1BottomLabel(typeof ideasMeta.axis_1_bottom_label === "string" ? ideasMeta.axis_1_bottom_label : "Bottom");
      setAxis2TopLabel(typeof ideasMeta.axis_2_top_label === "string" ? ideasMeta.axis_2_top_label : "Top");
      setAxis2BottomLabel(typeof ideasMeta.axis_2_bottom_label === "string" ? ideasMeta.axis_2_bottom_label : "Bottom");
      const legacyAxis1Positive = ideasMeta.axis_1_positive_end;
      const legacyAxis2Positive = ideasMeta.axis_2_positive_end;
      setAxis1LeftLabelPosition(
        ideasMeta.axis_1_left_label_position === "top"
          ? "top"
          : legacyAxis1Positive === "top"
            ? "bottom"
            : "top",
      );
      setAxis2TopLabelPosition(
        ideasMeta.axis_2_top_label_position === "bottom"
          ? "bottom"
          : legacyAxis2Positive === "bottom"
            ? "bottom"
            : "top",
      );
      setSeriesName(typeof ideasMeta.series_name === "string" ? ideasMeta.series_name : "");
      setShouldSave(true);
      setSavedRankingId(target.id);
      setIdeaInput(loadedIdeas.map((idea) => idea.text).join("\n"));
      setIdeas(loadedIdeas);
      setXOrder(xSorted.filter(Boolean));
      setYOrder(ySorted.filter(Boolean));
      setStep("result");

      setSaveStatus(`Loaded shared ranking #${rankingId}.`);
    }

    void loadSharedRankingFromUrl();
  }, []);

  useEffect(() => {
    if (!chartFrameRef.current) return;
    const node = chartFrameRef.current;
    const observer = new ResizeObserver(() => {
      setChartFrameSize({
        width: node.clientWidth,
        height: node.clientHeight,
      });
    });
    observer.observe(node);
    setChartFrameSize({
      width: node.clientWidth,
      height: node.clientHeight,
    });
    return () => observer.disconnect();
  }, [step]);

  const ideaById = useMemo(() => {
    return new Map(ideas.map((idea) => [idea.id, idea]));
  }, [ideas]);

  const rankedPoints = useMemo<RankedPoint[]>(() => {
    if (!xOrder.length || !yOrder.length) return [];

    const xRank = new Map(xOrder.map((id, idx) => [id, idx + 1]));
    const yRank = new Map(yOrder.map((id, idx) => [id, idx + 1]));
    const total = ideas.length;

    return ideas.map((idea) => ({
      idea: idea.text,
      xRank: xRank.get(idea.id) ?? 0,
      yRank: yRank.get(idea.id) ?? 0,
      x: centeredValueFromRank(xRank.get(idea.id) ?? 0, total, axis1LeftLabelPosition === "bottom"),
      y: centeredValueFromRank(yRank.get(idea.id) ?? 0, total, axis2TopLabelPosition === "top"),
      labelPlacement: "right",
    }));
  }, [ideas, xOrder, yOrder, axis1LeftLabelPosition, axis2TopLabelPosition]);

  const maxAbsDomain = useMemo(() => {
    if (!ideas.length) return 1;
    return Math.ceil(ideas.length / 2);
  }, [ideas.length]);

  const rankedPointsWithLabels = useMemo(() => {
    if (!rankedPoints.length) return [];
    if (chartFrameSize.width === 0 || chartFrameSize.height === 0) return rankedPoints;

    const margin = { top: 20, right: 20, bottom: 20, left: 20 };
    const innerPadding = 24; // matches chart wrapper padding
    const plot = {
      width: Math.max(1, chartFrameSize.width - innerPadding - margin.left - margin.right),
      height: Math.max(1, chartFrameSize.height - innerPadding - margin.top - margin.bottom),
      maxAbsDomain,
    };

    const placements = computePixelPlacements(
      rankedPoints.map((p) => ({ idea: p.idea, x: p.x, y: p.y })),
      plot,
    );

    return rankedPoints.map((point, index) => ({
      ...point,
      labelPlacement: placements[index],
    }));
  }, [rankedPoints, chartFrameSize.width, chartFrameSize.height, maxAbsDomain]);

  const axis1NegativeLabel = axis1LeftLabelPosition === "top" ? axis1TopLabel : axis1BottomLabel;
  const axis1PositiveLabel = axis1LeftLabelPosition === "top" ? axis1BottomLabel : axis1TopLabel;
  const axis2PositiveLabel = axis2TopLabelPosition === "top" ? axis2TopLabel : axis2BottomLabel;
  const axis2NegativeLabel = axis2TopLabelPosition === "top" ? axis2BottomLabel : axis2TopLabel;

  function goToIdeasStep() {
    if (
      !axis1.trim() ||
      !axis2.trim() ||
      !axis1TopLabel.trim() ||
      !axis1BottomLabel.trim() ||
      !axis2TopLabel.trim() ||
      !axis2BottomLabel.trim()
    ) {
      setSaveStatus("Please set axis names and both end labels.");
      return;
    }
    setSaveStatus("");
    setStep("ideas");
  }

  function startSorting() {
    const parsedIdeas = [...new Set(ideaInput.split("\n").map((line) => line.trim()).filter(Boolean))];
    if (parsedIdeas.length < 2) {
      setSaveStatus("Add at least 2 ideas (one per line).");
      return;
    }

    const currentByText = new Map(ideas.map((idea) => [idea.text, idea]));
    const canReuseExistingOrder =
      ideas.length === parsedIdeas.length &&
      parsedIdeas.every((text) => currentByText.has(text)) &&
      xOrder.length === ideas.length;

    if (canReuseExistingOrder) {
      const nextIdeas = parsedIdeas
        .map((text) => currentByText.get(text))
        .filter((idea): idea is Idea => Boolean(idea));
      const validIds = new Set(nextIdeas.map((idea) => idea.id));
      const nextXOrder = xOrder.filter((id) => validIds.has(id));
      const nextYOrder = yOrder.filter((id) => validIds.has(id));

      setIdeas(nextIdeas);
      setXOrder(nextXOrder);
      setYOrder(nextYOrder);
    } else {
      const nextIdeas = parsedIdeas.map((text, index) => ({
        id: `${Date.now()}-${index}`,
        text,
      }));
      const shuffled = shuffle(nextIdeas.map((idea) => idea.id));
      setIdeas(nextIdeas);
      setXOrder(shuffled);
      setYOrder([]);
    }

    setSaveStatus("");
    setStep("sortX");
  }

  function onDragEnd(currentOrder: string[], setOrder: (items: string[]) => void, event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = currentOrder.indexOf(String(active.id));
    const newIndex = currentOrder.indexOf(String(over.id));
    if (oldIndex < 0 || newIndex < 0) return;
    setOrder(arrayMove(currentOrder, oldIndex, newIndex));
  }

  async function finalizeRanking() {
    if (!xOrder.length || !yOrder.length) return;
    setSaveStatus("");
    setStep("result");
  }

  async function saveRanking() {
    if (!shouldSave) {
      setSaveStatus("Save disabled for this ranking.");
      return;
    }

    if (!rankedPointsWithLabels.length) return;

    setIsSaving(true);
    setSaveStatus("");

    const enteredSeriesName = seriesName.trim();
    const finalSeriesName = enteredSeriesName || nextDefaultSeriesName(savedRows);

    const payload = {
      axis_1_label: axis1.trim(),
      axis_2_label: axis2.trim(),
      ideas: {
        series_name: finalSeriesName,
        points: rankedPointsWithLabels.map(({ ...rest }) => rest),
        axis_1_top_label: axis1TopLabel.trim(),
        axis_1_bottom_label: axis1BottomLabel.trim(),
        axis_2_top_label: axis2TopLabel.trim(),
        axis_2_bottom_label: axis2BottomLabel.trim(),
        axis_1_left_label_position: axis1LeftLabelPosition,
        axis_2_top_label_position: axis2TopLabelPosition,
      },
      created_at: new Date().toISOString(),
    };

    const { data, error } = await supabase
      .from("idea_rankings")
      .insert(payload)
      .select("id, axis_1_label, axis_2_label, ideas, created_at")
      .single();

    if (error) {
      setSaveStatus(`Save failed: ${error.message}`);
      setIsSaving(false);
      return;
    }

    if (data) {
      setSavedRows((prev) => [data as SavedRankingRow, ...prev]);
      setSavedRankingId((data as SavedRankingRow).id);
      const url = new URL(window.location.href);
      url.searchParams.set("ranking", String((data as SavedRankingRow).id));
      window.history.replaceState({}, "", url.toString());
    }
    setSeriesName(finalSeriesName);
    setSaveStatus(
      enteredSeriesName
        ? `Ranking "${finalSeriesName}" saved to Supabase.`
        : `Ranking saved as "${finalSeriesName}" (date+iteration fallback).`,
    );
    setIsSaving(false);
  }

  function hydrateFromSavedRow(target: SavedRankingRow, targetStep: Step = "labels") {
    const ideasMeta = typeof target.ideas === "object" && target.ideas ? (target.ideas as Record<string, unknown>) : {};
    const points = Array.isArray(ideasMeta.points) ? (ideasMeta.points as SavedPoint[]) : [];
    if (!points.length) {
      setSaveStatus("Selected saved ranking has no points.");
      return;
    }

    const loadedIdeas = points.map((point, index) => ({
      id: `loaded-${target.id}-${index}`,
      text: point.idea,
    }));
    const idByIdea = new Map(loadedIdeas.map((idea) => [idea.text, idea.id]));

    const xSorted = [...points].sort((a, b) => a.xRank - b.xRank).map((point) => idByIdea.get(point.idea) ?? "");
    const ySorted = [...points].sort((a, b) => a.yRank - b.yRank).map((point) => idByIdea.get(point.idea) ?? "");

    setAxis1(target.axis_1_label);
    setAxis2(target.axis_2_label);
    setAxis1TopLabel(typeof ideasMeta.axis_1_top_label === "string" ? ideasMeta.axis_1_top_label : "Top");
    setAxis1BottomLabel(typeof ideasMeta.axis_1_bottom_label === "string" ? ideasMeta.axis_1_bottom_label : "Bottom");
    setAxis2TopLabel(typeof ideasMeta.axis_2_top_label === "string" ? ideasMeta.axis_2_top_label : "Top");
    setAxis2BottomLabel(typeof ideasMeta.axis_2_bottom_label === "string" ? ideasMeta.axis_2_bottom_label : "Bottom");
    const legacyAxis1Positive = ideasMeta.axis_1_positive_end;
    const legacyAxis2Positive = ideasMeta.axis_2_positive_end;
    setAxis1LeftLabelPosition(
      ideasMeta.axis_1_left_label_position === "top"
        ? "top"
        : legacyAxis1Positive === "top"
          ? "bottom"
          : "top",
    );
    setAxis2TopLabelPosition(
      ideasMeta.axis_2_top_label_position === "bottom"
        ? "bottom"
        : legacyAxis2Positive === "bottom"
          ? "bottom"
          : "top",
    );
    setSeriesName(typeof ideasMeta.series_name === "string" ? ideasMeta.series_name : "");
    setShouldSave(true);
    setSavedRankingId(target.id);
    setIdeaInput(loadedIdeas.map((idea) => idea.text).join("\n"));
    setIdeas(loadedIdeas);
    setXOrder(xSorted.filter(Boolean));
    setYOrder(ySorted.filter(Boolean));
    setSaveStatus("Saved ranking loaded. You can edit each stage.");
    setStep(targetStep);
  }

  function loadSavedRanking() {
    const target = savedRows.find((row) => String(row.id) === selectedSavedId);
    if (!target) return;
    hydrateFromSavedRow(target, "labels");
  }

  function beginAxis2Sort() {
    setYOrder(shuffle(ideas.map((idea) => idea.id)));
    setStep("sortY");
  }

  function resetAll() {
    setStep("labels");
    setAxis1("Effort");
    setAxis2("Impact");
    setAxis1TopLabel("High effort");
    setAxis1BottomLabel("Low effort");
    setAxis2TopLabel("High impact");
    setAxis2BottomLabel("Low impact");
    setAxis1LeftLabelPosition("bottom");
    setAxis2TopLabelPosition("top");
    setSeriesName("");
    setShouldSave(true);
    setSelectedSavedId("");
    setSavedRankingId(null);
    setIdeaInput("");
    setIdeas([]);
    setXOrder([]);
    setYOrder([]);
    setSaveStatus("");
    setIsSaving(false);
  }

  function editIdea(itemId: string, currentText: string) {
    const proposed = window.prompt("Edit this idea:", currentText);
    if (proposed === null) return;
    const nextText = proposed.trim();
    if (!nextText) {
      window.alert("Idea text cannot be empty.");
      return;
    }
    if (nextText === currentText) return;
    if (!window.confirm(`Change "${currentText}" to "${nextText}"?`)) return;

    setIdeas((prev) => prev.map((idea) => (idea.id === itemId ? { ...idea, text: nextText } : idea)));
    setIdeaInput((prevInput) => {
      const currentLines = prevInput.split("\n").map((line) => line.trim()).filter(Boolean);
      if (!currentLines.length) return prevInput;
      const nextLines = currentLines.map((line) => (line === currentText ? nextText : line));
      return nextLines.join("\n");
    });
    setSaveStatus("Idea updated.");
  }

  function deleteIdea(itemId: string, currentText: string) {
    if (ideas.length <= 2) {
      window.alert("At least 2 ideas are required.");
      return;
    }
    if (!window.confirm(`Delete "${currentText}" from this ranking?`)) return;

    setIdeas((prev) => prev.filter((idea) => idea.id !== itemId));
    setXOrder((prev) => prev.filter((id) => id !== itemId));
    setYOrder((prev) => prev.filter((id) => id !== itemId));
    setIdeaInput((prevInput) =>
      prevInput
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line && line !== currentText)
        .join("\n"),
    );
    setSaveStatus("Idea removed.");
  }

  async function shareSavedRanking() {
    if (!savedRankingId) return;
    const shareUrl = `${window.location.origin}${window.location.pathname}?ranking=${savedRankingId}`;
    await navigator.clipboard.writeText(shareUrl);
    setSaveStatus("Share URL copied to clipboard.");
  }

  return (
    <div className="min-h-screen bg-zinc-100 p-6 text-zinc-900">
      <main className="mx-auto max-w-4xl rounded-2xl border border-zinc-200 bg-white p-8 shadow-xl">
        <header className="mb-8">
          <h1 className="text-3xl font-bold tracking-tight">IdeaRanker</h1>
          <p className="mt-2 text-sm text-zinc-600">Rank ideas along two axes and visualize them as a scatter plot.</p>
        </header>

        {step === "labels" && (
          <section className="space-y-4">
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
              <h2 className="text-lg font-semibold">How this works</h2>
              <ol className="mt-2 list-inside list-decimal space-y-1 text-sm text-zinc-700">
                <li>
                  Define the two ways you&apos;ll rank your concepts, ideas, features, whatever. The classic example is
                  effort and impact. You&apos;ll also name the ends of those axes, like &quot;high effort&quot; and
                  &quot;low effort&quot;.
                </li>
                <li>List out all the ideas. Get &apos;em all out there!</li>
                <li>Rank the ideas along the first axis.</li>
                <li>Rank the ideas along the second axis.</li>
                <li>See the results!</li>
              </ol>
            </div>
            <h2 className="text-xl font-semibold">1. Define your axis</h2>
            <div className="grid gap-6 md:grid-cols-2">
              <div className="space-y-3 rounded-xl border border-zinc-200 p-4">
                <h3 className="font-semibold">X Axis</h3>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Axis name
                  <input
                    value={axis1}
                    onChange={(e) => setAxis1(e.target.value)}
                    className="rounded-lg border border-zinc-300 px-3 py-2 outline-none ring-indigo-500 focus:ring"
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Top end label
                  <input
                    value={axis1TopLabel}
                    onChange={(e) => setAxis1TopLabel(e.target.value)}
                    className="rounded-lg border border-zinc-300 px-3 py-2 outline-none ring-indigo-500 focus:ring"
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Bottom end label
                  <input
                    value={axis1BottomLabel}
                    onChange={(e) => setAxis1BottomLabel(e.target.value)}
                    className="rounded-lg border border-zinc-300 px-3 py-2 outline-none ring-indigo-500 focus:ring"
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Which label should be on the left? (left is negative)
                  <select
                    value={axis1LeftLabelPosition}
                    onChange={(e) => setAxis1LeftLabelPosition(e.target.value as "top" | "bottom")}
                    className="rounded-lg border border-zinc-300 px-3 py-2 outline-none ring-indigo-500 focus:ring"
                  >
                    <option value="top">Top end label on the left</option>
                    <option value="bottom">Bottom end label on the left</option>
                  </select>
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Series name (optional)
                  <input
                    value={seriesName}
                    onChange={(e) => setSeriesName(e.target.value)}
                    placeholder="Q2 Product Opportunities"
                    className="rounded-lg border border-zinc-300 px-3 py-2 outline-none ring-indigo-500 focus:ring"
                  />
                </label>
                <label className="flex items-center gap-2 text-sm font-medium">
                  <input
                    type="checkbox"
                    checked={shouldSave}
                    onChange={(e) => setShouldSave(e.target.checked)}
                    className="h-4 w-4 accent-indigo-600"
                  />
                  Save this ranking to Supabase
                </label>
              </div>

              <div className="space-y-3 rounded-xl border border-zinc-200 p-4">
                <h3 className="font-semibold">Y Axis</h3>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Axis name
                  <input
                    value={axis2}
                    onChange={(e) => setAxis2(e.target.value)}
                    className="rounded-lg border border-zinc-300 px-3 py-2 outline-none ring-indigo-500 focus:ring"
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Top end label
                  <input
                    value={axis2TopLabel}
                    onChange={(e) => setAxis2TopLabel(e.target.value)}
                    className="rounded-lg border border-zinc-300 px-3 py-2 outline-none ring-indigo-500 focus:ring"
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Bottom end label
                  <input
                    value={axis2BottomLabel}
                    onChange={(e) => setAxis2BottomLabel(e.target.value)}
                    className="rounded-lg border border-zinc-300 px-3 py-2 outline-none ring-indigo-500 focus:ring"
                  />
                </label>
                <label className="flex flex-col gap-2 text-sm font-medium">
                  Which label should be on top? (top is positive)
                  <select
                    value={axis2TopLabelPosition}
                    onChange={(e) => setAxis2TopLabelPosition(e.target.value as "top" | "bottom")}
                    className="rounded-lg border border-zinc-300 px-3 py-2 outline-none ring-indigo-500 focus:ring"
                  >
                    <option value="top">Top end label on top</option>
                    <option value="bottom">Bottom end label on top</option>
                  </select>
                </label>
              </div>
            </div>
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
              <h3 className="mb-3 text-sm font-semibold">Open and edit prior saved series</h3>
              <div className="flex flex-col gap-3 md:flex-row">
                <select
                  value={selectedSavedId}
                  onChange={(e) => setSelectedSavedId(e.target.value)}
                  className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm outline-none ring-indigo-500 focus:ring"
                >
                  <option value="">Select a saved series</option>
                  {savedRows.map((row) => {
                    const ideasMeta =
                      typeof row.ideas === "object" && row.ideas ? (row.ideas as Record<string, unknown>) : {};
                    const name = typeof ideasMeta.series_name === "string" && ideasMeta.series_name
                      ? ideasMeta.series_name
                      : `${row.created_at.slice(0, 10)}-${row.id}`;
                    return (
                      <option key={row.id} value={String(row.id)}>
                        {name}
                      </option>
                    );
                  })}
                </select>
                <button
                  type="button"
                  onClick={loadSavedRanking}
                  disabled={!selectedSavedId}
                  className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Load series
                </button>
              </div>
            </div>
            <button
              type="button"
              onClick={goToIdeasStep}
              className="rounded-lg bg-indigo-600 px-5 py-2.5 font-medium text-white hover:bg-indigo-500"
            >
              Continue
            </button>
          </section>
        )}

        {step === "ideas" && (
          <section className="space-y-4">
            <h2 className="text-xl font-semibold">2. Add ideas</h2>
            <p className="text-sm text-zinc-600">Enter one idea per line.</p>
            <textarea
              value={ideaInput}
              onChange={(e) => setIdeaInput(e.target.value)}
              rows={10}
              placeholder={"Improve onboarding\nLaunch referral program\nAutomate QA"}
              className="w-full rounded-lg border border-zinc-300 p-3 outline-none ring-indigo-500 focus:ring"
            />
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setStep("labels")}
                className="rounded-lg border border-zinc-300 px-5 py-2.5 font-medium hover:bg-zinc-50"
              >
                Back
              </button>
              <button
                type="button"
                onClick={startSorting}
                className="rounded-lg bg-indigo-600 px-5 py-2.5 font-medium text-white hover:bg-indigo-500"
              >
                Start ranking
              </button>
            </div>
          </section>
        )}

        {step === "sortX" && (
          <section className="space-y-4">
            <h2 className="text-xl font-semibold">3. Sort by {axis1}</h2>
            <p className="text-sm text-zinc-600">
              Drag cards vertically to rank from {axis1TopLabel} to {axis1BottomLabel}.
            </p>
            <p className="text-sm text-zinc-600">
              You can edit or delete items by hovering over them. ✎ = edit, 🗑 = delete.
            </p>
            <div className="space-y-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600">
              <p className="font-medium">{axis1TopLabel}</p>
              <div className="h-6 border-l border-dashed border-zinc-300" />
              <p className="font-medium">{axis1BottomLabel}</p>
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(event) => onDragEnd(xOrder, setXOrder, event)}
            >
              <SortableContext items={xOrder} strategy={verticalListSortingStrategy}>
                <ul className="space-y-3">
                  {xOrder.map((id) => (
                    <SortableIdeaCard
                      key={id}
                      id={id}
                      text={ideaById.get(id)?.text ?? "Unknown idea"}
                      onEdit={editIdea}
                      onDelete={deleteIdea}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
            <button
              type="button"
              onClick={beginAxis2Sort}
              className="rounded-lg bg-indigo-600 px-5 py-2.5 font-medium text-white hover:bg-indigo-500"
            >
              Continue to {axis2}
            </button>
          </section>
        )}

        {step === "sortY" && (
          <section className="space-y-4">
            <h2 className="text-xl font-semibold">4. Sort by {axis2}</h2>
            <p className="text-sm text-zinc-600">
              Drag cards vertically to rank from {axis2TopLabel} to {axis2BottomLabel}.
            </p>
            <p className="text-sm text-zinc-600">
              You can edit or delete items by hovering over them. ✎ = edit, 🗑 = delete.
            </p>
            <div className="space-y-2 rounded-xl border border-zinc-200 bg-zinc-50 p-3 text-xs text-zinc-600">
              <p className="font-medium">{axis2TopLabel}</p>
              <div className="h-6 border-l border-dashed border-zinc-300" />
              <p className="font-medium">{axis2BottomLabel}</p>
            </div>
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(event) => onDragEnd(yOrder, setYOrder, event)}
            >
              <SortableContext items={yOrder} strategy={verticalListSortingStrategy}>
                <ul className="space-y-3">
                  {yOrder.map((id) => (
                    <SortableIdeaCard
                      key={id}
                      id={id}
                      text={ideaById.get(id)?.text ?? "Unknown idea"}
                      onEdit={editIdea}
                      onDelete={deleteIdea}
                    />
                  ))}
                </ul>
              </SortableContext>
            </DndContext>
            <button
              type="button"
              disabled={isSaving}
              onClick={finalizeRanking}
              className="rounded-lg bg-indigo-600 px-5 py-2.5 font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-70"
            >
              {isSaving ? "Saving..." : "Show chart"}
            </button>
          </section>
        )}

        {step === "result" && (
          <section className="space-y-4">
            <h2 className="text-xl font-semibold">Final map</h2>
            <div ref={chartFrameRef} className="relative h-[420px] rounded-xl border border-zinc-200 p-3">
              <p className="pointer-events-none absolute left-1/2 top-1 -translate-x-1/2 text-[10px] text-zinc-500">
                {axis2PositiveLabel}
              </p>
              <p className="pointer-events-none absolute bottom-1 left-1/2 -translate-x-1/2 text-[10px] text-zinc-500">
                {axis2NegativeLabel}
              </p>
              <p className="pointer-events-none absolute left-1 top-1/2 -translate-y-1/2 text-[10px] text-zinc-500">
                {axis1NegativeLabel}
              </p>
              <p className="pointer-events-none absolute right-1 top-1/2 -translate-y-1/2 text-[10px] text-zinc-500">
                {axis1PositiveLabel}
              </p>
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 20, right: 20, bottom: 20, left: 20 }}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <ReferenceLine x={0} stroke="#111827" strokeWidth={2.5} />
                  <ReferenceLine y={0} stroke="#111827" strokeWidth={2.5} />
                  <XAxis
                    dataKey="x"
                    type="number"
                    allowDecimals={false}
                    domain={[-maxAbsDomain, maxAbsDomain]}
                    label={{ value: axis1, position: "insideBottom", offset: -5 }}
                  />
                  <YAxis
                    dataKey="y"
                    type="number"
                    allowDecimals={false}
                    domain={[-maxAbsDomain, maxAbsDomain]}
                    label={{ value: axis2, angle: -90, position: "insideLeft" }}
                  />
                  <Tooltip
                    cursor={{ strokeDasharray: "3 3" }}
                    content={({ active, payload }) => {
                      if (!active || !payload?.length) return null;
                      const point = payload[0]?.payload as RankedPoint | undefined;
                      if (!point) return null;
                      return (
                        <div className="rounded border border-zinc-300 bg-white px-2 py-1 text-xs shadow">
                          <p className="font-semibold text-zinc-800">{point.idea}</p>
                          <p className="text-zinc-600">
                            ({point.x}, {point.y})
                          </p>
                        </div>
                      );
                    }}
                  />
                  <Scatter data={rankedPointsWithLabels} fill="#4f46e5">
                    <LabelList
                      dataKey="idea"
                      content={(props) => {
                        const dataIndex = typeof props.index === "number" ? props.index : -1;
                        const payload = dataIndex >= 0 ? rankedPointsWithLabels[dataIndex] : undefined;
                        if (!payload || payload.labelPlacement === "none") return null;

                        const x = Number(props.x ?? 0);
                        const y = Number(props.y ?? 0);
                        const placement = payload.labelPlacement;
                        const dx = placement === "right" ? 8 : -18;
                        const dy = placement === "below" ? 14 : placement === "above" ? -8 : 4;
                        const anchor = placement === "right" ? "start" : "middle";

                        return (
                          <text x={x + dx} y={y + dy} fill="#52525b" fontSize={10} textAnchor={anchor}>
                            {payload.idea}
                          </text>
                        );
                      }}
                    />
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>

            <ol className="space-y-2 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
              {rankedPointsWithLabels.map((point) => (
                <li key={point.idea} className="text-sm text-zinc-700">
                  <span className="font-medium">{point.idea}</span> - {axis1}: {point.x} + {axis2}: {point.y}
                </li>
              ))}
            </ol>

            <div className="space-y-3 rounded-xl border border-zinc-200 bg-zinc-50 p-4">
              <label className="flex items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={shouldSave}
                  onChange={(e) => setShouldSave(e.target.checked)}
                  className="h-4 w-4 accent-indigo-600"
                />
                Save this ranking
              </label>
              {shouldSave && (
                <>
                  <label className="flex flex-col gap-2 text-sm font-medium">
                    Series name (optional)
                    <input
                      value={seriesName}
                      onChange={(e) => setSeriesName(e.target.value)}
                      placeholder="If blank, we'll use date+iteration (e.g. 2026-04-08-1)"
                      className="rounded-lg border border-zinc-300 px-3 py-2 outline-none ring-indigo-500 focus:ring"
                    />
                  </label>
                  {!seriesName.trim() && (
                    <p className="text-xs text-zinc-600">
                      If you do not name it, it will be saved with a date+iteration schema.
                    </p>
                  )}
                  <button
                    type="button"
                    disabled={isSaving}
                    onClick={saveRanking}
                    className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-70"
                  >
                    {isSaving ? "Saving..." : "☁ Save ranking"}
                  </button>
                  <button
                    type="button"
                    disabled={!savedRankingId}
                    onClick={shareSavedRanking}
                    className="rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    📋 Copy URL for Sharing
                  </button>
                </>
              )}
            </div>

            <div className="grid gap-3 text-sm text-zinc-700 md:grid-cols-2">
              <p className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                <span className="font-medium">X ends:</span> top = {axis1TopLabel} | bottom = {axis1BottomLabel} | left
                (negative) = {axis1NegativeLabel}
              </p>
              <p className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
                <span className="font-medium">Y ends:</span> top = {axis2TopLabel} | bottom = {axis2BottomLabel} | top
                (positive) = {axis2PositiveLabel}
              </p>
            </div>

            <button
              type="button"
              onClick={resetAll}
              className="rounded-lg border border-zinc-300 px-5 py-2.5 font-medium hover:bg-zinc-50"
            >
              Start new ranking
            </button>
          </section>
        )}

        {saveStatus && <p className="mt-6 text-sm text-zinc-600">{saveStatus}</p>}
      </main>
    </div>
  );
}
