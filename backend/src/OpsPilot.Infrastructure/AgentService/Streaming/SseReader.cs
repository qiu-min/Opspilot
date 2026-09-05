using System.Runtime.CompilerServices;
using System.Text;

namespace OpsPilot.Infrastructure.AgentService.Streaming;

internal static class SseReader
{
    public static async IAsyncEnumerable<SseFrame> ReadAsync(
        Stream stream,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        using var reader = new StreamReader(
            stream,
            Encoding.UTF8,
            detectEncodingFromByteOrderMarks: true,
            bufferSize: 1024,
            leaveOpen: true);
        string eventName = string.Empty;
        var dataLines = new List<string>();

        while (await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false) is { } line)
        {
            if (line.Length == 0)
            {
                if (dataLines.Count > 0)
                {
                    yield return CreateFrame(eventName, dataLines);
                }

                eventName = string.Empty;
                dataLines.Clear();
                continue;
            }

            if (line[0] == ':') continue;

            int separatorIndex = line.IndexOf(':');
            string field = separatorIndex < 0 ? line : line[..separatorIndex];
            string value = separatorIndex < 0 ? string.Empty : line[(separatorIndex + 1)..];
            if (value.StartsWith(' ')) value = value[1..];

            switch (field)
            {
                case "event":
                    eventName = value;
                    break;
                case "data":
                    dataLines.Add(value);
                    break;
            }
        }

        if (dataLines.Count > 0)
        {
            yield return CreateFrame(eventName, dataLines);
        }
    }

    private static SseFrame CreateFrame(string eventName, IReadOnlyList<string> dataLines) =>
        new(
            string.IsNullOrEmpty(eventName) ? "message" : eventName,
            string.Join('\n', dataLines));
}
