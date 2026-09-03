import sys
import os
import json
import argparse
import pymupdf

def main():
    parser = argparse.ArgumentParser(description="Render PDF pages to PNG images for OCR processing.")
    parser.add_argument("--pdf", required=True, help="Path to PDF file")
    parser.add_argument("--outdir", required=True, help="Output directory for PNG images")
    parser.add_argument("--start", type=int, default=1, help="Start page (1-indexed)")
    parser.add_argument("--end", type=int, default=0, help="End page (1-indexed, 0 for all)")
    parser.add_argument("--dpi", type=int, default=150, help="DPI resolution for rendering")

    args = parser.parse_args()

    if not os.path.exists(args.pdf):
        print(json.dumps({"error": f"PDF file not found: {args.pdf}"}))
        sys.exit(1)

    os.makedirs(args.outdir, exist_ok=True)

    try:
        doc = pymupdf.open(args.pdf)
        total_pages = len(doc)

        start_idx = max(0, args.start - 1)
        end_idx = total_pages if args.end <= 0 else min(total_pages, args.end)

        rendered_pages = []
        for idx in range(start_idx, end_idx):
            page_num = idx + 1
            page = doc[idx]
            pix = page.get_pixmap(dpi=args.dpi)
            out_path = os.path.join(args.outdir, f"page_{page_num}.png")
            pix.save(out_path)
            rendered_pages.append({
                "page": page_num,
                "path": out_path
            })

        print(json.dumps({
            "success": True,
            "totalPages": total_pages,
            "renderedCount": len(rendered_pages),
            "pages": rendered_pages
        }))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)

if __name__ == "__main__":
    main()
