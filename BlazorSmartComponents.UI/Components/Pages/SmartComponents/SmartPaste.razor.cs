namespace BlazorSmartComponents.UI.Components.Pages.SmartComponents
{
    public partial class SmartPaste
    {
        string[] projects =
[
        "Sales intranet",
            "Customer portal",
            "Mobile app",
            "Mobile app (v2 beta)",
            "PowerEye Security",
        ];

            Component[] components =
            [
                new("backup", "Backup/restore"),
            new("ui", "User interface"),
            new("webhooks", "Web hooks"),
            new("llm", "Language models"),
            new("offline", "Offline support"),
            new("windows", "Windows"),
            new("mac", "Mac"),
            new("linux", "Linux"),
            new("build", "Build system"),
            new("perf", "Performance"),
            new("security", "Security"),
        ];

            record Component(string Id, string Name);
    }
}
